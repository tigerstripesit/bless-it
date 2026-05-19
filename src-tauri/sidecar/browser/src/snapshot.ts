// AX-tree → flat indexed element list. The model receives this as the
// perception primitive; element indices it returns in browser_act are
// resolved back to coordinates / locators here.
//
// Each node may carry `tags` computed from the live DOM (page.evaluate):
//   - "password": text input is a password/credit-card field. Typing into
//     it is classified `write` (requires approval).
//   - "form_submit": button/link whose enclosing <form> contains a
//     password/email/credit-card input. Clicking it is classified `write`
//     (submits credentials).
// browser_classify reads these tags to decide whether browser_act needs
// user approval. Tags are best-effort — pages without semantic <form>
// markup may slip through; the model should err on the side of caution.

import type { Page } from 'playwright-core';
import { log } from './log.js';

export interface AxNode {
    index: number;
    role: string;
    name: string;
    value?: string;
    description?: string;
    /** True when the node has no children, false otherwise. Useful for the
     *  model to know "this is a leaf the user could interact with" vs
     *  "this is a container; click a child". */
    leaf: boolean;
    /** Children indices, if any. Flattened so the model can scan linearly. */
    children?: number[];
    /** Risk tags computed from the live DOM (see module docstring). */
    tags?: string[];
}

const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'tab',
    'slider',
    'spinbutton',
]);

const STRUCTURAL_ROLES = new Set([
    'heading',
    'list',
    'listitem',
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'form',
    'dialog',
    'alertdialog',
    'tablist',
    'tabpanel',
    'menu',
    'menubar',
]);

interface RawAx {
    role?: string;
    name?: string;
    value?: string;
    description?: string;
    children?: RawAx[];
}

interface FlattenOptions {
    maxElements: number;
    tagMap?: TagMap;
}

/** Map keyed by lowercased "role::name" → tag list. Built once per observe
 *  call from a single page.evaluate; matched onto AX nodes during flatten. */
type TagMap = Map<string, string[]>;

function tagKey(role: string, name: string): string {
    return `${role.toLowerCase()}::${name.trim().toLowerCase()}`;
}

function shouldKeep(node: RawAx): boolean {
    if (!node.role) return false;
    // Exclude off-screen accessibility skip-navigation shortcuts. These appear
    // as the first AX nodes on Atlassian (and many other) pages with names like
    // "Skip to:", "Skip to Main Content", "Skip to sidebar". They are
    // positioned off-screen via CSS and Playwright can never click them —
    // any attempt times out after 30 s. Remove them from the tree entirely
    // so the model never receives their index and cannot attempt to use them.
    const nameLC = (node.name ?? '').trim().toLowerCase();
    if (nameLC.startsWith('skip to') || nameLC === 'skip navigation') return false;
    if (INTERACTIVE_ROLES.has(node.role)) return true;
    if (STRUCTURAL_ROLES.has(node.role) && (node.name?.trim().length ?? 0) > 0) return true;
    // Plain text nodes carry the page's prose; keep them when they have a name
    // so the model can read the page content without scrolling pixels.
    if (node.role === 'text' && (node.name?.trim().length ?? 0) > 0) return true;
    if (node.role === 'StaticText' && (node.name?.trim().length ?? 0) > 0) return true;
    return false;
}

function clamp(s: string | undefined, n: number): string | undefined {
    if (!s) return undefined;
    const t = s.replace(/\s+/g, ' ').trim();
    if (!t) return undefined;
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Walk a Playwright accessibility snapshot and emit a flat indexed list. */
function flatten(root: RawAx, opts: FlattenOptions): AxNode[] {
    const out: AxNode[] = [];
    const queue: Array<{ node: RawAx; parentIndex: number | null }> = [{ node: root, parentIndex: null }];
    const tagMap = opts.tagMap;

    while (queue.length > 0 && out.length < opts.maxElements) {
        const { node, parentIndex } = queue.shift()!;
        const children = node.children ?? [];

        if (shouldKeep(node)) {
            const idx = out.length;
            const tags = tagMap?.get(tagKey(node.role!, node.name ?? '')) ?? undefined;
            const flat: AxNode = {
                index: idx,
                role: node.role!,
                name: clamp(node.name, 200) ?? '',
                value: clamp(node.value, 200),
                description: clamp(node.description, 200),
                leaf: children.length === 0,
                ...(tags && tags.length ? { tags } : {}),
            };
            out.push(flat);
            if (parentIndex !== null) {
                const parent = out[parentIndex];
                parent.children = parent.children ?? [];
                parent.children.push(idx);
            }
            for (const c of children) queue.push({ node: c, parentIndex: idx });
        } else {
            // Skip this node but keep walking its children — they may carry
            // the real interactive content. The parent index stays the same.
            for (const c of children) queue.push({ node: c, parentIndex });
        }
    }

    return out;
}

/**
 * Compute risk tags for accessible elements via a single page.evaluate.
 * Returns a map keyed by lowercased "role::name" → tag list. Matched onto
 * AX nodes during flatten.
 *
 * Algorithm:
 *   1. Find all <form> elements containing password/email/credit-card inputs
 *      → these forms are "sensitive".
 *   2. Buttons/links inside a sensitive form → tag "form_submit".
 *   3. Any input[type=password] → tag "password".
 *
 * Best-effort: pages without semantic <form> markup (React modals, custom
 * components) may slip through. browser_classify defaults closed on unknown
 * methods, so the model is steered toward calling browser_observe again
 * after navigation rather than blindly clicking.
 */
async function buildTagMap(page: Page): Promise<TagMap> {
    try {
        const entries = await page.evaluate(() => {
            const out: Array<[string, string]> = [];
            const sensitiveSelector = [
                'input[type="password"]',
                'input[type="email"]',
                'input[autocomplete*="password"]',
                'input[autocomplete*="credit-card"]',
                'input[autocomplete*="cc-"]',
            ].join(',');
            const sensitiveForms = new Set<Element>();
            for (const inp of Array.from(document.querySelectorAll(sensitiveSelector))) {
                const form = inp.closest('form');
                if (form) sensitiveForms.add(form);
            }

            const nameOf = (el: Element): string => {
                const aria = el.getAttribute('aria-label');
                if (aria) return aria.trim();
                const labelledby = el.getAttribute('aria-labelledby');
                if (labelledby) {
                    const node = document.getElementById(labelledby);
                    if (node?.textContent) return node.textContent.trim();
                }
                const text = (el as HTMLElement).innerText || el.textContent || '';
                return text.trim();
            };
            const roleOf = (el: Element): string => {
                const explicit = el.getAttribute('role');
                if (explicit) return explicit.toLowerCase();
                const tag = el.tagName.toLowerCase();
                if (tag === 'button' || (tag === 'input' && (el as HTMLInputElement).type === 'submit')) return 'button';
                if (tag === 'a' && (el as HTMLAnchorElement).hasAttribute('href')) return 'link';
                if (tag === 'input') return 'textbox';
                return tag;
            };

            // form_submit: anything clickable inside a sensitive form
            for (const el of Array.from(document.querySelectorAll('button, [role="button"], a[href], input[type="submit"]'))) {
                const form = el.closest('form');
                if (form && sensitiveForms.has(form)) {
                    out.push([`${roleOf(el)}::${nameOf(el).toLowerCase()}`, 'form_submit']);
                }
            }
            // password: any password input
            for (const inp of Array.from(document.querySelectorAll('input[type="password"]'))) {
                out.push([`textbox::${nameOf(inp).toLowerCase()}`, 'password']);
                const ph = (inp as HTMLInputElement).placeholder;
                if (ph) out.push([`textbox::${ph.trim().toLowerCase()}`, 'password']);
            }
            return out;
        });

        const map: TagMap = new Map();
        for (const [key, tag] of entries) {
            const existing = map.get(key);
            if (existing) {
                if (!existing.includes(tag)) existing.push(tag);
            } else {
                map.set(key, [tag]);
            }
        }
        return map;
    } catch (e) {
        log.warn('buildTagMap failed; classification falls back to defaults', { err: String(e) });
        return new Map();
    }
}

export async function captureAxTree(page: Page, maxElements: number): Promise<AxNode[]> {
    try {
        const [snapshot, tagMap] = await Promise.all([
            page.accessibility.snapshot({ interestingOnly: false }),
            buildTagMap(page),
        ]);
        if (!snapshot) return [];
        return flatten(snapshot as RawAx, { maxElements, tagMap });
    } catch (e) {
        log.warn('captureAxTree failed', { err: String(e) });
        return [];
    }
}

export async function captureScreenshot(page: Page): Promise<string | undefined> {
    try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
        return buf.toString('base64');
    } catch (e) {
        log.warn('captureScreenshot failed', { err: String(e) });
        return undefined;
    }
}
