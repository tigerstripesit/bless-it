#!/usr/bin/env node
//
// Production sidecar packaging — produces a single Node executable for the
// host's target triple (or one specified on the command line).
//
// Pipeline:
//   1. esbuild bundle src/index.ts → dist/bundle.cjs (CJS, single file, all
//      runtime dependencies inlined except `playwright-core` which we keep
//      external so Playwright's @playwright/test isn't bundled).
//   2. Node SEA: emit a blob from the bundled CJS via the experimental
//      single-executable-application API (stable surface in Node ≥ 20.10).
//   3. Copy the host's `node` binary, postject the blob into it.
//   4. macOS: strip and re-ad-hoc-sign so dyld accepts the modified binary.
//   5. Output to `../../binaries/ittoolkit-browser-<triple>(.exe)` so
//      tauri.conf.json's externalBin entry can pick it up.
//
// Usage:
//   node scripts/build-sidecar.mjs                 # build for host
//   node scripts/build-sidecar.mjs <target-triple> # explicit target
//
// Notes:
//   - Playwright Chromium is NOT bundled by this script. The user runs
//     `npx playwright install chromium` once; the resulting cache is then
//     packaged by Tauri as a bundle resource (configured separately).
//   - This script needs ≥ Node 20.10 (SEA feature flag was promoted to
//     non-experimental between 20.10 and 20.12).
//   - Cross-compile is NOT supported here — to build a Linux binary you
//     run this script on Linux. CI fans this out per OS.

import { execSync } from 'node:child_process';
import {
    copyFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = resolve(here, '..');
const binariesDir = resolve(sidecarRoot, '..', '..', 'binaries');

const NODE_PLATFORM_TO_TRIPLE = {
    'arm64-darwin': 'aarch64-apple-darwin',
    'x64-darwin': 'x86_64-apple-darwin',
    'x64-linux': 'x86_64-unknown-linux-gnu',
    'arm64-linux': 'aarch64-unknown-linux-gnu',
    'x64-win32': 'x86_64-pc-windows-msvc',
};

const target =
    process.argv[2] ??
    NODE_PLATFORM_TO_TRIPLE[`${process.arch}-${process.platform}`];

if (!target) {
    console.error(`Unsupported host: ${process.arch}-${process.platform}. Pass a target triple as the first argument.`);
    process.exit(1);
}

const isWindows = target.includes('windows');
const isMac = target.includes('darwin');
const ext = isWindows ? '.exe' : '';

mkdirSync(binariesDir, { recursive: true });
mkdirSync(join(sidecarRoot, 'dist'), { recursive: true });

console.log(`[sidecar] target = ${target}`);

// 1) Bundle.
console.log('[sidecar] bundling with esbuild …');
execSync(
    'npx esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --external:playwright-core --outfile=dist/bundle.cjs',
    { cwd: sidecarRoot, stdio: 'inherit' },
);

// 2) SEA blob.
console.log('[sidecar] creating SEA blob …');
writeFileSync(
    join(sidecarRoot, 'sea-config.json'),
    JSON.stringify(
        {
            main: 'dist/bundle.cjs',
            output: 'dist/sea-prep.blob',
            disableExperimentalSEAWarning: true,
        },
        null,
        2,
    ),
);
execSync('node --experimental-sea-config sea-config.json', {
    cwd: sidecarRoot,
    stdio: 'inherit',
});

// 3) Copy host node + postject inject.
const outName = `ittoolkit-browser-${target}${ext}`;
const outPath = join(binariesDir, outName);
if (existsSync(outPath)) rmSync(outPath);
copyFileSync(process.execPath, outPath);
chmodSync(outPath, 0o755);

console.log('[sidecar] injecting SEA blob with postject …');
const sentinel = isMac
    ? '--macho-segment-name NODE_SEA'
    : '';
execSync(
    `npx postject "${outPath}" NODE_SEA_BLOB "${join(sidecarRoot, 'dist', 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ${sentinel}`,
    { stdio: 'inherit' },
);

// 4) macOS: re-ad-hoc-sign the binary so dyld will load it after mutation.
if (isMac) {
    console.log('[sidecar] re-signing (ad-hoc) …');
    try {
        execSync(`codesign --remove-signature "${outPath}"`, { stdio: 'inherit' });
    } catch {
        // Some hosts ship a node binary without an existing signature; ignore.
    }
    execSync(`codesign --sign - "${outPath}"`, { stdio: 'inherit' });
}

console.log(`[sidecar] built ${outPath}`);
console.log('[sidecar] add this binary to tauri.conf.json externalBin if it is not already there:');
console.log(`           "binaries/ittoolkit-browser"`);
console.log('[sidecar] Tauri will resolve the host triple suffix automatically at build time.');
