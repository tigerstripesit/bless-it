import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { log } from './log.js';
import type { AxNode } from './snapshot.js';

function ensureChromiumInstalled(): void {
    try {
        const exePath = chromium.executablePath();
        if (!existsSync(exePath)) {
            throw new Error(`chromium binary not found at expected path: ${exePath}`);
        }
    } catch {
        const cwd = process.cwd();
        throw new Error(
            `Chromium is not installed. Run the following from the sidecar directory:\n\n` +
            `  cd ${cwd}\n` +
            `  npm run postinstall\n\n` +
            `This will download the Chromium browser binary required for browser automation.`
        );
    }
}

export interface SessionObservation {
    ax: AxNode[];
    capturedAt: number;
}

export interface SessionRef {
    sessionId: string;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    /** Last AX snapshot. browser_act resolves params.index against this; if
     *  stale (>30s) or absent, the act handler re-snapshots. */
    lastObservation: SessionObservation | null;
}

const sessions = new Map<string, SessionRef>();

export interface OpenOptions {
    sessionId: string;
    profile: 'ephemeral' | 'persistent';
    viewport?: { width: number; height: number };
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

function profileDir(sessionId: string): string {
    return join(homedir(), '.ittoolkit', 'browser', 'profiles', sessionId);
}

export async function getOrOpenSession(opts: OpenOptions): Promise<SessionRef> {
    // Verify Chromium is installed before attempting to launch.
    ensureChromiumInstalled();

    const existing = sessions.get(opts.sessionId);
    if (existing) return existing;

    const viewport = opts.viewport ?? DEFAULT_VIEWPORT;

    if (opts.profile === 'persistent') {
        const dir = profileDir(opts.sessionId);
        await mkdir(dir, { recursive: true });
        const context = await chromium.launchPersistentContext(dir, {
            headless: true,
            viewport,
        });
        const page = context.pages()[0] ?? (await context.newPage());
        // launchPersistentContext returns BrowserContext directly; there's no
        // distinct Browser handle. Synthesize a close() shim so the rest of
        // the code can uniformly call browser.close().
        const browser = { close: () => context.close() } as unknown as Browser;
        const ref: SessionRef = {
            sessionId: opts.sessionId, browser, context, page, lastObservation: null,
        };
        sessions.set(opts.sessionId, ref);
        log.info('session opened (persistent)', { sessionId: opts.sessionId });
        return ref;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const ref: SessionRef = {
        sessionId: opts.sessionId, browser, context, page, lastObservation: null,
    };
    sessions.set(opts.sessionId, ref);
    log.info('session opened (ephemeral)', { sessionId: opts.sessionId });
    return ref;
}

export function getSession(sessionId: string): SessionRef | undefined {
    return sessions.get(sessionId);
}

export async function closeSession(sessionId: string): Promise<boolean> {
    const ref = sessions.get(sessionId);
    if (!ref) return false;
    sessions.delete(sessionId);
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
