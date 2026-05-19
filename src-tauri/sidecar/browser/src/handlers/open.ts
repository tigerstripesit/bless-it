import { getOrOpenSession } from '../sessions.js';

interface OpenParams {
    session_id?: string;
    profile?: 'ephemeral' | 'persistent';
    viewport?: { width: number; height: number };
    headed?: boolean;
}

export async function handleOpen(params: OpenParams): Promise<{ session_id: string }> {
    if (!params.session_id || typeof params.session_id !== 'string') {
        throw new Error('browser.open requires "session_id" (string)');
    }
    await getOrOpenSession({
        sessionId: params.session_id,
        profile: params.profile === 'persistent' ? 'persistent' : 'ephemeral',
        viewport: params.viewport,
        headed: params.headed,
    });
    return { session_id: params.session_id };
}
