import { getSession } from '../sessions.js';
import { captureAxTree, captureScreenshot, type AxNode } from '../snapshot.js';

interface ObserveParams {
    session_id?: string;
    include_screenshot?: boolean;
    max_elements?: number;
    /** Wait for network idle before capturing the AX snapshot.
     *  Overrides the site profile setting when explicitly provided.
     *  Default: false (unless the matched site profile sets waitForIdle). */
    wait_for_idle?: boolean;
}

export async function handleObserve(params: ObserveParams): Promise<{
    url: string;
    title: string;
    ax: AxNode[];
    screenshot?: string;
    site_profile?: string;
}> {
    if (!params.session_id) throw new Error('browser.observe requires "session_id"');
    const ref = getSession(params.session_id);
    if (!ref) {
        throw new Error(`browser.observe: session "${params.session_id}" not open. Call browser.open first.`);
    }

    const profile = ref.siteProfile;

    // Param overrides profile; profile overrides default (false).
    const shouldWaitIdle = params.wait_for_idle ?? profile?.waitForIdle ?? false;

    // For SPAs, wait for network to quiesce before snapshotting.
    // Capped at 10s — networkidle may never fire on pages with websockets.
    if (shouldWaitIdle) {
        await ref.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    // Wait for a site-specific readiness signal (e.g. WhatsApp's #pane-side).
    if (profile?.readySelector) {
        await ref.page.waitForSelector(profile.readySelector, {
            timeout: profile.readyTimeout ?? 10_000,
        }).catch(() => {});
    }

    const maxElements = params.max_elements ?? profile?.axMaxElements ?? 80;
    const includeScreenshot = params.include_screenshot !== false;

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
        ...(profile ? { site_profile: profile.name } : {}),
    };
}
