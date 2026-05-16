# Browser-use sidecar

A small Node + Playwright process that the Tauri host (`src-tauri/src/browser_commands.rs`) spawns on demand to give the agent a real browser.

## Wire protocol

Newline-delimited JSON-RPC 2.0 over stdio. One JSON document per line.

Request → response (host → sidecar):

```jsonc
{ "jsonrpc": "2.0", "id": "call_42", "method": "browser.observe",
  "params": { "session_id": "s1" } }
```

```jsonc
{ "jsonrpc": "2.0", "id": "call_42", "result": { "url": "…", "title": "…",
  "ax": [ … ], "screenshot": "…base64…" } }
```

Event (sidecar → host, `id` omitted/null):

```jsonc
{ "jsonrpc": "2.0", "method": "browser.frame",
  "params": { "session_id": "s1", "jpeg": "…" } }
```

## Methods (M1)

- `browser.ping` → `{ ok: true }`. Liveness check.
- `browser.open` → `{ session_id }`.
- `browser.navigate` → `{ url, title }`.
- `browser.observe` → `{ url, title, ax, screenshot? }`.
- `browser.close` → `{ closed: true }`.

`browser.act` and `browser.extract` arrive in M2/M3.

## Running locally (dev)

```bash
npm install
npm run install-chromium
npm run dev    # interactive: type JSON-RPC frames on stdin, one per line
```

`cargo run` / `npm run tauri dev` will spawn `node dist/index.js` automatically — no further packaging required.

## Production build

```bash
npm install
npm run install-chromium
npm run package        # → ../../binaries/ittoolkit-browser-<host-triple>(.exe)
```

The packager (`scripts/build-sidecar.mjs`) does:

1. esbuild bundle → `dist/bundle.cjs` (Playwright kept external).
2. Node SEA blob (`node --experimental-sea-config`) → `dist/sea-prep.blob`.
3. Copy `process.execPath` and `postject` the blob into it.
4. macOS: strip + ad-hoc re-sign so dyld will load the modified binary.

After the binary exists, add this entry to `src-tauri/tauri.conf.json`
inside `bundle` before running `cargo tauri build`:

```jsonc
"externalBin": ["binaries/ittoolkit-browser"]
```

(Tauri suffixes the target triple itself — `…-aarch64-apple-darwin`,
`…-x86_64-pc-windows-msvc.exe`, etc.) We intentionally keep that line out
of the committed `tauri.conf.json` because `cargo check` fails when an
`externalBin` entry points at a missing file, which would break local
development for anyone who hasn't run the packager yet.

`BrowserSupervisor` (in `src-tauri/src/browser_commands.rs`) tries the
packaged binary first at runtime, then falls back to `node dist/index.js`,
so the same Rust code path works in both modes.
