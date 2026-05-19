// Sidecar logs go to stderr so they don't pollute the JSON-RPC stream on
// stdout. The Rust host tails stderr separately for debugging.

function emit(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
    const line = extra === undefined
        ? `[sidecar ${level}] ${msg}`
        : `[sidecar ${level}] ${msg} ${safeStringify(extra)}`;
    process.stderr.write(line + '\n');
}

function safeStringify(v: unknown): string {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

export const log = {
    info: (msg: string, extra?: unknown) => emit('info', msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
