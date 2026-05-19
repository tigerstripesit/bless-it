// browser_act handler — click/type/select/scroll/press/hover by AX index.
//
// Resolves params.index against the session's cached AX snapshot. If the
// cache is stale (>30s) or the URL changed since last observe, we re-snapshot.
//
// Locator resolution uses a multi-strategy chain with a per-strategy timeout
// so a single bad strategy never blocks for 30s. Strategies in priority order:
//   0. Site-profile strategies (prepended from site-profiles.ts, site knows its DOM best)
//   1. getByRole(role, { name, exact })    — standard AX match
//   2. getByText(name, { exact })          — text/statictext nodes in SPAs
//   3. [aria-label="name"]                 — custom ARIA labels (chat apps etc.)
//   4. [title="name"]                      — title attributes
//   5. css=[aria-label="name"]             — shadow DOM piercing
//   6. getByRole(role).first()             — nth-of-role last resort
//
// If the final click/fill still throws, a screenshot is attached to the error
// so the model can pivot to visual reasoning instead of retrying blindly.

import type { Page, Locator } from 'playwright-core';
import { getSession } from '../sessions.js';
import { captureAxTree, captureScreenshot, type AxNode } from '../snapshot.js';
import { log } from '../log.js';
import type { SiteProfile } from '../site-profiles.js';

const SNAPSHOT_STALE_MS = 30_000;
const STRATEGY_TIMEOUT_MS = 5_000;

type ActionKind = 'click' | 'type' | 'select' | 'scroll' | 'press' | 'hover';
const ALLOWED_ACTIONS = new Set<ActionKind>(['click', 'type', 'select', 'scroll', 'press', 'hover']);

interface ActParams {
    session_id?: string;
    action?: string;
    index?: number;
    text?: string;
    submit?: boolean;
}

interface ActResult {
    url: string;
    title: string;
    target_tags?: string[];
    target_role?: string;
    target_name?: string;
}

function pwRole(axRole: string): Parameters<Page['getByRole']>[0] {
    // Normalize ARIA roles to Playwright's role enum. text/statictext are NOT
    // paragraph — they are generic text nodes rendered as span/div in SPAs.
    // We handle them via getByText() in resolveLocator instead.
    const r = axRole.toLowerCase();
    return r as Parameters<Page['getByRole']>[0];
}

/** Try a locator with a short timeout. Returns the locator if ≥1 match found, else null. */
async function tryLocator(loc: Locator): Promise<Locator | null> {
    const count = await Promise.race([
        loc.count(),
        new Promise<number>((_, rej) =>
            setTimeout(() => rej(new Error('strategy timeout')), STRATEGY_TIMEOUT_MS)
        ),
    ]).catch(() => 0);
    if (count >= 1) return count === 1 ? loc : loc.first();
    return null;
}

async function resolveLocator(page: Page, node: AxNode, profile?: SiteProfile): Promise<Locator> {
    const role = pwRole(node.role);
    const name = node.name ?? '';
    const isTextNode = node.role === 'text' || node.role === 'StaticText';
    const escaped = name.replace(/"/g, '\\"');

    // Strategy 0: site-profile strategies — tried first because the site knows its own DOM best.
    // (e.g. WhatsApp: [aria-label="{name}"] before generic role-based lookup)
    if (name && profile?.locatorStrategies) {
        for (const strat of profile.locatorStrategies) {
            if (strat.roles && !strat.roles.includes(node.role)) continue;
            const sel = strat.selector.replace(/{name}/g, escaped);
            const loc = await tryLocator(page.locator(sel));
            if (loc) return loc;
        }
    }

    // Strategy 1: exact role + name (standard AX match — works for buttons, links, etc.)
    if (name && !isTextNode) {
        const loc = await tryLocator(page.getByRole(role, { name, exact: true }));
        if (loc) return loc;
    }

    // Strategy 2: getByText — the right approach for text/statictext nodes in SPAs.
    // WhatsApp, Gmail etc. render these as <span>/<div> with no <p> tag; getByRole
    // ('paragraph') would find nothing. getByText matches the visible text content.
    if (name && isTextNode) {
        const loc = await tryLocator(page.getByText(name, { exact: true }));
        if (loc) return loc;
    }

    // Strategy 3: aria-label attribute (custom components, chat lists, icon buttons)
    if (name) {
        const loc = await tryLocator(page.locator(`[aria-label="${escaped}"]`));
        if (loc) return loc;
    }

    // Strategy 4: title attribute
    if (name) {
        const loc = await tryLocator(page.locator(`[title="${escaped}"]`));
        if (loc) return loc;
    }

    // Strategy 5: shadow DOM piercing — catches elements nested inside Web Components
    if (name) {
        const loc = await tryLocator(page.locator(`css=[aria-label="${escaped}"]`));
        if (loc) return loc;
    }

    // Strategy 6: nth-of-role fallback. For text nodes with no useful role, fall
    // back to getByText without exact match as a last DOM attempt.
    if (name && isTextNode) {
        const loc = await tryLocator(page.getByText(name));
        if (loc) return loc;
    }

    // Last resort: return nth-of-role (may be wrong element, but avoids infinite hang)
    return page.getByRole(role).first();
}

export async function handleAct(params: ActParams): Promise<ActResult> {
    if (!params.session_id) throw new Error('browser.act requires "session_id"');
    const action = (params.action ?? '') as ActionKind;
    if (!ALLOWED_ACTIONS.has(action)) {
        throw new Error(`browser.act: unknown action "${params.action}". Allowed: ${[...ALLOWED_ACTIONS].join(', ')}`);
    }

    const ref = getSession(params.session_id);
    if (!ref) {
        throw new Error(`browser.act: session "${params.session_id}" not open. Call browser.open first.`);
    }

    const now = Date.now();
    const currentUrl = ref.page.url();
    let observation = ref.lastObservation;

    // Fail explicitly when URL changed since last observe — silently re-snapping and applying
    // the old index to a new AX tree maps to a completely wrong element.
    const urlChanged = observation && observation.url !== currentUrl;
    if (urlChanged) {
        throw new Error(
            `browser.act: page navigated from "${observation!.url}" to "${currentUrl}" since last observe. ` +
            `Call browser_observe to get fresh element indices before acting.`
        );
    }
    if (!observation || now - observation.capturedAt > SNAPSHOT_STALE_MS) {
        const ax = await captureAxTree(ref.page, 80);
        observation = { ax, capturedAt: now, url: currentUrl };
        ref.lastObservation = observation;
    }

    // scroll and press don't target a specific node.
    if (action === 'scroll') {
        const direction = (params.text ?? 'down').toLowerCase();
        const delta = direction === 'up' ? -600 : direction === 'top' ? -1_000_000 : direction === 'bottom' ? 1_000_000 : 600;
        await ref.page.mouse.wheel(0, delta);
    } else if (action === 'press') {
        const key = (params.text ?? '').trim();
        if (!key) throw new Error('browser.act press requires "text" with the key name (e.g. "Enter").');
        await ref.page.keyboard.press(key);
    } else {
        const idx = typeof params.index === 'number' ? params.index : -1;
        if (idx < 0 || idx >= observation.ax.length) {
            throw new Error(`browser.act: index ${idx} out of range (have ${observation.ax.length} nodes). Call browser_observe to refresh.`);
        }
        const node = observation.ax[idx];

        // Site-profile preActDelayMs: some SPAs re-render between observe and act.
        const preDelay = ref.siteProfile?.preActDelayMs;
        if (preDelay) {
            await new Promise(r => setTimeout(r, preDelay));
        }

        const locator = await resolveLocator(ref.page, node, ref.siteProfile);

        try {
            switch (action) {
                case 'click':
                    await locator.click();
                    break;
                case 'type': {
                    const text = params.text ?? '';
                    await locator.fill(text);
                    if (params.submit) {
                        await locator.press('Enter');
                    }
                    break;
                }
                case 'select': {
                    const value = params.text ?? '';
                    await locator.selectOption(value);
                    break;
                }
                case 'hover':
                    await locator.hover();
                    break;
            }
        } catch (err) {
            // Tier 4: vision fallback — attach screenshot to the error so the model
            // can pivot to visual reasoning (browser_mark) instead of retrying blindly.
            const screenshot = await captureScreenshot(ref.page).catch(() => undefined);
            const msg = err instanceof Error ? err.message : String(err);
            const rich = new Error(`browser.act failed: ${msg}`);
            (rich as any).screenshot = screenshot;
            throw rich;
        }
    }

    const [url, title] = await Promise.all([
        Promise.resolve(ref.page.url()),
        ref.page.title().catch(() => ''),
    ]);

    let target_role: string | undefined;
    let target_name: string | undefined;
    let target_tags: string[] | undefined;
    if (typeof params.index === 'number' && params.index >= 0 && params.index < observation.ax.length) {
        const node = observation.ax[params.index];
        target_role = node.role;
        target_name = node.name;
        target_tags = node.tags;
    }
    ref.lastObservation = null;

    return { url, title, target_role, target_name, target_tags };
}
