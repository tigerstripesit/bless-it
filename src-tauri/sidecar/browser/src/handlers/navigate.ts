import { getSession } from '../sessions.js';
import { matchProfile } from '../site-profiles.js';
import { log } from '../log.js';

interface NavigateParams {
    session_id?: string;
    url?: string;
    wait_until?: 'load' | 'domcontentloaded' | 'networkidle';
}

export async function handleNavigate(params: NavigateParams): Promise<{
    url: string;
    title: string;
    site_profile?: string;
}> {
    if (!params.session_id) throw new Error('browser.navigate requires "session_id"');
    if (!params.url) throw new Error('browser.navigate requires "url"');

    const ref = getSession(params.session_id);
    if (!ref) {
        throw new Error(`browser.navigate: session "${params.session_id}" not open. Call browser.open first.`);
    }
    if (ref.page.isClosed()) {
        throw new Error(`browser.navigate: session "${params.session_id}" has a closed page — call browser.open again to reopen.`);
    }

    await ref.page.goto(params.url, {
        waitUntil: params.wait_until ?? 'domcontentloaded',
        timeout: 30_000,
    });

    // Match and attach a site profile for the landed URL (post-redirect final URL).
    const landedUrl = ref.page.url();
    const profile = matchProfile(landedUrl);
    ref.siteProfile = profile;

    if (profile) {
        log.info('site-profile matched', { name: profile.name, url: landedUrl });

        // Auto-dismiss known cookie banners / modals (fire-and-forget).
        if (profile.dismissSelectors?.length) {
            for (const sel of profile.dismissSelectors) {
                await ref.page.locator(sel).first()
                    .click({ timeout: 2_000 })
                    .catch(() => {});
            }
        }
    }

    return {
        url: landedUrl,
        title: await ref.page.title(),
        ...(profile ? { site_profile: profile.name } : {}),
    };
}
