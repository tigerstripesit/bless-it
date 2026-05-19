// browser_mark — Set of Marks (SOM) visual grounding tool.
//
// Overlays numbered bounding boxes on a screenshot of the current page.
// Each mark corresponds to an interactive AX node; the model can reference
// marks by number and then call browser_act with the matching index.
//
// This bridges DOM-based and vision-based reasoning: the model sees both the
// structured AX list and a screenshot annotated with numbers, so it can
// confidently pick the right element even for visually-complex SPAs where
// names alone are ambiguous (e.g. multiple unlabelled icon buttons).
//
// Technique popularised by Browser-Use and Vercel's agent-browser (2025).

import type { Page } from 'playwright-core';
import { getSession } from '../sessions.js';
import { captureAxTree, type AxNode } from '../snapshot.js';
import { log } from '../log.js';

interface MarkParams {
    session_id?: string;
    max_elements?: number;
}

interface Mark {
    /** Number shown in the overlay (1-based for readability). */
    number: number;
    /** AX node index — pass this to browser_act as `index`. */
    index: number;
    role: string;
    name: string;
}

interface MarkResult {
    url: string;
    title: string;
    /** Base64-encoded JPEG screenshot with numbered overlays. */
    screenshot: string;
    /** Mapping of overlay numbers → AX indices. */
    marks: Mark[];
}

const OVERLAY_ID = '__ittoolkit_som_overlay__';

async function injectOverlay(page: Page, boxes: Array<{ number: number; x: number; y: number; width: number; height: number }>): Promise<void> {
    await page.evaluate(({ OVERLAY_ID, boxes }) => {
        const existing = document.getElementById(OVERLAY_ID);
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.id = OVERLAY_ID;
        container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';

        for (const b of boxes) {
            // Bounding box outline
            const outline = document.createElement('div');
            outline.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;border:2px solid #f56;box-sizing:border-box;`;

            // Number label
            const label = document.createElement('div');
            label.textContent = String(b.number);
            label.style.cssText = `position:absolute;left:${b.x}px;top:${Math.max(0, b.y - 18)}px;background:#f56;color:#fff;font:bold 11px/16px monospace;padding:0 3px;border-radius:2px;white-space:nowrap;`;

            container.appendChild(outline);
            container.appendChild(label);
        }
        document.body.appendChild(container);
    }, { OVERLAY_ID, boxes });
}

async function removeOverlay(page: Page): Promise<void> {
    await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
    }, OVERLAY_ID).catch(() => {});
}

export async function handleMark(params: MarkParams): Promise<MarkResult> {
    if (!params.session_id) throw new Error('browser.mark requires "session_id"');
    const ref = getSession(params.session_id);
    if (!ref) {
        throw new Error(`browser.mark: session "${params.session_id}" not open. Call browser.open first.`);
    }

    const maxElements = typeof params.max_elements === 'number' && params.max_elements > 0
        ? Math.min(params.max_elements, 200)
        : 80;

    const ax = await captureAxTree(ref.page, maxElements);

    // Resolve bounding boxes for interactive leaf nodes only.
    const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox',
        'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
        'option', 'tab', 'slider', 'spinbutton',
    ]);

    const boxes: Array<{ number: number; x: number; y: number; width: number; height: number }> = [];
    const marks: Mark[] = [];
    let markNumber = 1;

    for (const node of ax) {
        if (!INTERACTIVE_ROLES.has(node.role) && node.role !== 'text' && node.role !== 'StaticText') continue;
        if (!node.name) continue;

        try {
            const escaped = node.name.replace(/"/g, '\\"');
            // Try aria-label first (most specific), then role+name
            let locator = ref.page.locator(`[aria-label="${escaped}"]`);
            let count = await locator.count().catch(() => 0);
            if (count === 0) {
                locator = ref.page.getByRole(node.role as any, { name: node.name, exact: true });
                count = await locator.count().catch(() => 0);
            }
            if (count === 0) continue;

            const el = count === 1 ? locator : locator.first();
            const bb = await el.boundingBox().catch(() => null);
            if (!bb || bb.width === 0 || bb.height === 0) continue;

            boxes.push({ number: markNumber, x: Math.round(bb.x), y: Math.round(bb.y), width: Math.round(bb.width), height: Math.round(bb.height) });
            marks.push({ number: markNumber, index: node.index, role: node.role, name: node.name });
            markNumber++;
        } catch (e) {
            log.warn('browser.mark: bounding box resolution failed', { node: node.index, err: String(e) });
        }
    }

    // Inject overlay, screenshot, then remove overlay
    await injectOverlay(ref.page, boxes);
    const buf = await ref.page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
    await removeOverlay(ref.page);

    const [url, title] = await Promise.all([
        Promise.resolve(ref.page.url()),
        ref.page.title().catch(() => ''),
    ]);

    // Update the cached observation so browser_act can use the same snapshot
    ref.lastObservation = { ax, capturedAt: Date.now(), url };

    return {
        url,
        title,
        screenshot: buf.toString('base64'),
        marks,
    };
}
