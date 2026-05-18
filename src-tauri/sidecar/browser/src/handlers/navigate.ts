import { getSession } from '../sessions.js';

interface NavigateParams {
    session_id?: string;
    url?: string;
    wait_until?: 'load' | 'domcontentloaded' | 'networkidle';
}

export async function handleNavigate(params: NavigateParams): Promise<{
    url: string;
    title: string;
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

    return {
        url: ref.page.url(),
        title: await ref.page.title(),
    };
}
