import { getSession } from '../sessions.js';
import { captureAxTree, captureScreenshot, type AxNode } from '../snapshot.js';

interface ObserveParams {
    session_id?: string;
    include_screenshot?: boolean;
    max_elements?: number;
    /** When true, wait for network idle before capturing the AX snapshot.
     *  Use for SPAs (WhatsApp Web, Gmail, etc.) where domcontentloaded fires
     *  before the JS framework renders interactive content. Default: false. */
    wait_for_idle?: boolean;
}

export async function handleObserve(params: ObserveParams): Promise<{
    url: string;
    title: string;
    ax: AxNode[];
    screenshot?: string;
}> {
    if (!params.session_id) throw new Error('browser.observe requires "session_id"');
    const ref = getSession(params.session_id);
    if (!ref) {
        throw new Error(`browser.observe: session "${params.session_id}" not open. Call browser.open first.`);
    }

    const maxElements = typeof params.max_elements === 'number' && params.max_elements > 0
        ? Math.min(params.max_elements, 200)
        : 80;
    const includeScreenshot = params.include_screenshot !== false;

    // For SPAs, wait for the JS framework to finish rendering before snapshotting.
    // Capped at 10s — networkidle may never fire on pages with polling/websockets.
    if (params.wait_for_idle) {
        await ref.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    const [ax, screenshot, title] = await Promise.all([
        captureAxTree(ref.page, maxElements),
        includeScreenshot ? captureScreenshot(ref.page) : Promise.resolve(undefined),
        ref.page.title().catch(() => ''),
    ]);

    ref.lastObservation = { ax, capturedAt: Date.now(), url: ref.page.url() };

    return {
        url: ref.page.url(),
        title,
        ax,
        ...(screenshot ? { screenshot } : {}),
    };
}
