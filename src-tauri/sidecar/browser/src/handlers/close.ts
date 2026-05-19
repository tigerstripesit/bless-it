import { closeSession } from '../sessions.js';

interface CloseParams {
    session_id?: string;
}

export async function handleClose(params: CloseParams): Promise<{ closed: boolean }> {
    if (!params.session_id) throw new Error('browser.close requires "session_id"');
    const ok = await closeSession(params.session_id);
    return { closed: ok };
}
