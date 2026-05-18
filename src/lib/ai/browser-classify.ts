/**
 * Browser-use risk classification.
 *
 * Mirrors `shell-classify.ts` for the browser tool surface. Used by
 * `inference-with-tools.ts` to decide whether a browser_* call requires
 * user approval via `onConfirmExecution`. The Rust side enforces the same
 * rules in `src-tauri/src/browser_classify.rs` — never trust this
 * classifier alone.
 *
 * Tiers:
 *   - read         : autonomous (observe, navigate to http(s), open, close, extract).
 *   - write        : requires approval (form submits, password typing, click on form_submit).
 *   - destructive  : requires approval, hard-default risky (file:/javascript:/mailto:/tel: navigation).
 */

export type BrowserRisk = 'read' | 'write' | 'destructive';

/** AX node tag set the sidecar emits via snapshot.ts. Mirrored here so the
 *  classifier can reason about browser_act intent before dispatch. */
export interface BrowserActHints {
    /** Tags from the AX node at params.index (set by the latest browser_observe). */
    tags?: string[];
    /** AX role of the node (button / textbox / link / …). */
    role?: string;
}

interface ClassifyArgs {
    method: string; // browser_open / browser_navigate / browser_observe / browser_act / browser_close / browser_extract
    params: Record<string, unknown>;
    /** Hints derived from the latest browser_observe — only meaningful for browser_act. */
    hints?: BrowserActHints;
}

const DESTRUCTIVE_URL_SCHEMES = /^(mailto:|tel:|file:|javascript:)/i;

export function classifyBrowserAction({ method, params, hints }: ClassifyArgs): BrowserRisk {
    switch (method) {
        case 'browser_open':
        case 'browser_close':
        case 'browser_observe':
        case 'browser_extract':
        case 'browser_mark':
            return 'read';

        case 'browser_navigate': {
            const url = String(params.url ?? '').trim();
            if (!url) return 'write'; // default closed on bogus input
            if (DESTRUCTIVE_URL_SCHEMES.test(url)) return 'destructive';
            if (/^https?:\/\//i.test(url)) return 'read';
            return 'write';
        }

        case 'browser_act': {
            const action = String(params.action ?? '').toLowerCase();
            const submit = params.submit === true;
            const tags = hints?.tags ?? [];

            // Explicit form submit → write regardless of action shape.
            if (submit) return 'write';
            // Typing into a password / credit-card field → write.
            if (action === 'type' && tags.includes('password')) return 'write';
            // Clicking a button inside a sensitive form → write.
            if (action === 'click' && tags.includes('form_submit')) return 'write';
            // press Enter on a password-tagged field is a credential submit.
            if (action === 'press' && tags.includes('password')) return 'write';

            // Pure-read interactions: hover, scroll, plain typing into search-like
            // boxes (no password tag), single-target clicks on non-submit elements.
            if (['hover', 'scroll'].includes(action)) return 'read';
            if (action === 'type' || action === 'select' || action === 'press' || action === 'click') {
                return 'read';
            }
            return 'write'; // unknown action — default closed
        }

        default:
            // Unknown browser_* method. Default closed: model has to ask
            // explicit permission to do something we don't recognize.
            return 'write';
    }
}

/**
 * Human-friendly one-line summary of an intended browser action — rendered
 * on confirm_action cards alongside the screenshot ("Click 'Reset password'
 * on https://admin.example.com/users/123").
 */
export function describeBrowserAction(args: ClassifyArgs, url: string | undefined): string {
    const { method, params, hints } = args;
    const u = url ?? (params.url as string | undefined) ?? '';
    switch (method) {
        case 'browser_navigate':
            return `Navigate to ${params.url ?? '(missing)'}`;
        case 'browser_act': {
            const action = String(params.action ?? '');
            const name = hints?.role && (params as Record<string, unknown>).name
                ? `${hints.role} "${(params as Record<string, unknown>).name}"`
                : `element [${params.index ?? '?'}]`;
            const onUrl = u ? ` on ${u}` : '';
            if (action === 'click') return `Click ${name}${onUrl}`;
            if (action === 'type') return `Type into ${name}${onUrl}`;
            if (action === 'press') return `Press "${params.text ?? '?'}" on ${name}${onUrl}`;
            if (action === 'select') return `Select "${params.text ?? '?'}" in ${name}${onUrl}`;
            return `${action} ${name}${onUrl}`;
        }
        default:
            return method;
    }
}
