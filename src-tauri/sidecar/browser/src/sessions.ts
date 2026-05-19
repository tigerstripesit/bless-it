import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { log } from './log.js';
import type { AxNode } from './snapshot.js';
import type { SiteProfile } from './site-profiles.js';

function ensureChromiumInstalled(): void {
    try {
        const exePath = chromium.executablePath();
        if (!existsSync(exePath)) {
            throw new Error(`chromium binary not found at expected path: ${exePath}`);
        }
    } catch {
        throw new Error(
            `Chromium is not installed. Run:\n\n` +
            `  cd src-tauri/sidecar/browser && npm run postinstall\n\n` +
            `This will download the Chromium binary required for browser automation.`
        );
    }
}

/**
 * Check whether Chromium is available and, if not, download it automatically.
 * Intended to be called once at sidecar startup before accepting RPC requests.
 *
 * `onProgress` is called with human-readable status messages that the caller
 * can forward to the Rust host as `sidecar.progress` notifications.
 *
 * In production builds where playwright-core is not available as a module
 * (Chromium is expected to be bundled as a Tauri resource) this is a no-op.
 */
export async function autoInstallChromiumIfNeeded(
    onProgress: (msg: string) => void,
): Promise<void> {
    try {
        const exePath = chromium.executablePath();
        if (existsSync(exePath)) return;
    } catch {
        // executablePath() can throw if the playwright-core registry is not
        // initialised — treat the same as "not found".
    }

    onProgress(
        'Chromium not found — downloading browser for first-time setup (this may take a few minutes)…',
    );

    const { execFileSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');

    // Locate the playwright CLI that ships alongside playwright-core.
    // createRequire(import.meta.url) works for the ESM-compiled dist files.
    // Fall back to a path heuristic for unusual layouts.
    let cliPath: string | null = null;
    try {
        const req = createRequire(import.meta.url);
        cliPath = req.resolve('playwright-core/cli');
    } catch {
        const { fileURLToPath } = await import('node:url');
        const { dirname } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const candidate = join(here, '..', 'node_modules', 'playwright-core', 'cli.js');
        if (existsSync(candidate)) cliPath = candidate;
    }

    if (!cliPath) {
        // Production binary: Chromium should be bundled as a Tauri resource.
        log.warn('playwright CLI not found — skipping auto-install (expected in production build)');
        return;
    }

    // Run `node <cli> install chromium`.
    // stdout stays clean (JSON-RPC stream); install progress goes to stderr
    // which Rust drains into the app log.
    execFileSync(process.execPath, [cliPath, 'install', 'chromium'], {
        stdio: ['ignore', process.stderr, process.stderr],
        timeout: 10 * 60 * 1000,
    });

    onProgress('Chromium installed — browser ready.');
}

export interface SessionObservation {
    ax: AxNode[];
    capturedAt: number;
    /** URL at capture time — used to detect page navigations that invalidate the snapshot. */
    url: string;
}

export interface SessionRef {
    sessionId: string;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    /** Last AX snapshot. browser_act resolves params.index against this; if
     *  stale (>30s) or absent, the act handler re-snapshots. */
    lastObservation: SessionObservation | null;
    /** CDP session used for screencast streaming; null for internal sessions. */
    cdp: CDPSession | null;
    /** Whether Chromium was launched with a visible window. */
    headed: boolean;
    /** Profile mode — needed so promotion preserves the original intent. */
    profile: 'ephemeral' | 'persistent';
    /** Site-specific config matched from the current page URL. Set/updated on
     *  every browser.navigate. Undefined for unrecognised sites. */
    siteProfile?: SiteProfile;
}

const sessions = new Map<string, SessionRef>();

export interface OpenOptions {
    sessionId: string;
    profile: 'ephemeral' | 'persistent';
    viewport?: { width: number; height: number };
    headed?: boolean;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

// Real Chrome 124 UA. Avoids ADFS / enterprise portals blocking headless detection.
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function profileDir(sessionId: string): string {
    return join(homedir(), '.ittoolkit', 'browser', 'profiles', sessionId);
}

/** Emit a browser.frame JSON-RPC notification on stdout so the Rust host
 *  forwards it to the frontend as a Tauri `browser-frame` event. */
function emitFrame(sessionId: string, jpeg: string, url: string): void {
    process.stdout.write(
        JSON.stringify({
            jsonrpc: '2.0',
            method: 'browser.frame',
            params: { session_id: sessionId, jpeg, url },
        }) + '\n',
    );
}

/** Upgrade an existing headless session to headed mode, preserving all state.
 *
 * Persistent sessions: Chromium has already flushed cookies/localStorage to the
 * profile dir — closing and relaunching headed picks them up automatically.
 *
 * Ephemeral sessions: cookies live only in memory, so we extract them via the
 * context API before teardown and inject them back after relaunch. Form data
 * and sessionStorage are not portable across browser processes, but the
 * navigation URL and cookies are, which covers the SSO redirect / login flow.
 */
async function promoteToHeaded(ref: SessionRef): Promise<SessionRef> {
    const lastUrl = (() => { try { return ref.page.url(); } catch { return null; } })();
    // For ephemeral sessions, save cookies before the process dies.
    const savedCookies = ref.profile === 'ephemeral'
        ? await ref.context.cookies().catch(() => [])
        : [];

    // Tear down the headless session.
    if (ref.cdp) await ref.cdp.send('Page.stopScreencast').catch(() => {});
    sessions.delete(ref.sessionId);
    await ref.browser.close().catch(() => {});

    // Reopen as headed (persistent sessions will reload profile from disk automatically).
    const newRef = await getOrOpenSession({
        sessionId: ref.sessionId,
        profile: ref.profile,
        headed: true,
    });

    // Restore ephemeral cookies.
    if (savedCookies.length > 0) {
        await newRef.context.addCookies(savedCookies).catch(() => {});
    }

    // Navigate back to where we were.
    if (lastUrl && lastUrl !== 'about:blank' && lastUrl !== '') {
        await newRef.page.goto(lastUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    }

    log.info('session promoted to headed', { sessionId: ref.sessionId, lastUrl, profile: ref.profile });
    return newRef;
}

/** Start a CDP screencast on `page` and wire frame → stdout notifications.
 *  Skips internal sessions (sessionId starting with '_').
 *  Returns the CDPSession so closeSession can stop it, or null on failure. */
async function startScreencast(page: Page, sessionId: string): Promise<CDPSession | null> {
    if (sessionId.startsWith('_')) return null;
    try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 80,
            maxWidth: 1280,
            maxHeight: 800,
            everyNthFrame: 1,
        });
        cdp.on('Page.screencastFrame', async (event: any) => {
            const url = (() => { try { return page.url(); } catch { return ''; } })();
            emitFrame(sessionId, event.data as string, url);
            // Ack so Chromium sends the next frame (natural backpressure).
            await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        });
        log.info('screencast started', { sessionId });
        return cdp;
    } catch (e) {
        log.warn('startScreencast failed; BrowserView will show on-demand screenshots only', {
            sessionId, err: String(e),
        });
        return null;
    }
}

/** Evict a session from the map without attempting to close the browser
 *  (used from close-event listeners where the browser is already gone). */
function evictSession(sessionId: string, ref: SessionRef): void {
    if (sessions.get(sessionId) === ref) {
        sessions.delete(sessionId);
        log.warn('session evicted (browser/page closed externally)', { sessionId });
    }
}

/** Wire up page-close and browser-disconnect listeners so stale sessions are
 *  removed from the map automatically rather than silently accumulating. */
function watchSession(ref: SessionRef): void {
    ref.page.once('close', () => evictSession(ref.sessionId, ref));
    // For real Browser objects (ephemeral), listen for disconnects.
    if (typeof (ref.browser as any).on === 'function') {
        ref.browser.on('disconnected', () => evictSession(ref.sessionId, ref));
    }
}

export async function getOrOpenSession(opts: OpenOptions): Promise<SessionRef> {
    // Verify Chromium is installed before attempting to launch.
    ensureChromiumInstalled();

    const existing = sessions.get(opts.sessionId);
    if (existing) {
        // Validate the session is still usable — the page or browser may have
        // been closed externally (user closed the window, crash, previous
        // navigation error). Returning a stale ref causes the next RPC to
        // throw "Target page, context or browser has been closed".
        // browser.isConnected() exists on real Browser objects but not on the
        // persistent-context shim `{ close }`. Guard with typeof so replay of
        // persistent-profile workflows doesn't crash.
        const stale = existing.page.isClosed() ||
            (typeof (existing.browser as any).isConnected === 'function' && !existing.browser.isConnected());
        if (stale) {
            log.warn('stale session detected, evicting and reopening', { sessionId: opts.sessionId });
            sessions.delete(opts.sessionId);
            await existing.browser.close().catch(() => {});
            // Fall through to create a fresh session below.
        } else {
            // Transparent headed upgrade: agent detected human interaction needed
            // and re-called browser_open with headed:true. Promote without losing state.
            if (opts.headed && !existing.headed) {
                return promoteToHeaded(existing);
            }
            return existing;
        }
    }

    const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
    const headed = opts.headed ?? false;
    const headless = !headed;
    const profile = opts.profile === 'persistent' ? 'persistent' : 'ephemeral';

    if (profile === 'persistent') {
        const dir = profileDir(opts.sessionId);
        await mkdir(dir, { recursive: true });
        const context = await chromium.launchPersistentContext(dir, {
            headless,
            viewport,
            userAgent: DEFAULT_USER_AGENT,
            // Suppress the `navigator.webdriver` flag that enterprise portals
            // (ADFS, Azure AD) use to detect and block headless browsers.
            args: ['--disable-blink-features=AutomationControlled'],
        });
        const page = context.pages()[0] ?? (await context.newPage());
        // launchPersistentContext returns BrowserContext directly; there's no
        // distinct Browser handle. Synthesize a close() shim so the rest of
        // the code can uniformly call browser.close().
        const browser = { close: () => context.close() } as unknown as Browser;
        const cdp = await startScreencast(page, opts.sessionId);
        const ref: SessionRef = {
            sessionId: opts.sessionId, browser, context, page,
            lastObservation: null, cdp, headed, profile,
        };
        sessions.set(opts.sessionId, ref);
        // For persistent contexts the browser shim has no real event emitter;
        // watch the context close event instead.
        context.once('close', () => evictSession(opts.sessionId, ref));
        log.info('session opened (persistent)', { sessionId: opts.sessionId, headed });
        return ref;
    }

    const browser = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
        viewport,
        userAgent: DEFAULT_USER_AGENT,
    });
    const page = await context.newPage();
    const cdp = await startScreencast(page, opts.sessionId);
    const ref: SessionRef = {
        sessionId: opts.sessionId, browser, context, page,
        lastObservation: null, cdp, headed, profile,
    };
    sessions.set(opts.sessionId, ref);
    watchSession(ref);
    log.info('session opened (ephemeral)', { sessionId: opts.sessionId, headed });
    return ref;
}

export function getSession(sessionId: string): SessionRef | undefined {
    return sessions.get(sessionId);
}

export async function closeSession(sessionId: string): Promise<boolean> {
    const ref = sessions.get(sessionId);
    if (!ref) return false;
    sessions.delete(sessionId);
    if (ref.cdp) {
        await ref.cdp.send('Page.stopScreencast').catch(() => {});
    }
    try {
        await ref.browser.close();
    } catch (e) {
        log.warn('error closing session', { sessionId, err: String(e) });
    }
    log.info('session closed', { sessionId });
    return true;
}

export async function closeAllSessions(): Promise<void> {
    const ids = Array.from(sessions.keys());
    for (const id of ids) await closeSession(id);
}
