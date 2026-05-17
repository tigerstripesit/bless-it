// JSON-RPC 2.0 dispatcher for the browser-use sidecar.
//
// Reads newline-delimited JSON-RPC frames on stdin, writes responses on
// stdout, logs to stderr. Concurrent requests are allowed — each frame's
// `id` is echoed back on the matching response.
//
// NOTE: All module imports are dynamic so that missing dependencies (e.g.
// playwright-core not installed) are caught and reported as a structured
// error notification on stdout rather than causing a silent crash.

import { log } from './log.js';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
    method?: string;
    params?: unknown;
}

async function main(): Promise<void> {
    let HANDLERS: Record<string, (params: any) => Promise<unknown>>;
    let closeAllSessions: () => Promise<void>;

    try {
        const [open, navigate, observe, close, act, extract, sessions] = await Promise.all([
            import('./handlers/open.js'),
            import('./handlers/navigate.js'),
            import('./handlers/observe.js'),
            import('./handlers/close.js'),
            import('./handlers/act.js'),
            import('./handlers/extract.js'),
            import('./sessions.js'),
        ]);

        HANDLERS = {
            'browser.ping': async () => ({ ok: true, pid: process.pid }),
            'browser.open': open.handleOpen,
            'browser.navigate': navigate.handleNavigate,
            'browser.observe': observe.handleObserve,
            'browser.act': act.handleAct,
            'browser.extract': extract.handleExtract,
            'browser.close': close.handleClose,
        };
        closeAllSessions = sessions.closeAllSessions;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('sidecar failed to load modules', { err: message });
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'sidecar.error',
            params: { message },
        }) + '\n');
        await new Promise(resolve => process.stdout.write('', resolve));
        process.exit(1);
    }

    function write(frame: JsonRpcResponse): void {
        process.stdout.write(JSON.stringify(frame) + '\n');
    }

    async function dispatch(req: JsonRpcRequest): Promise<void> {
        const id = req.id ?? null;
        const handler = HANDLERS[req.method];
        if (!handler) {
            write({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Method not found: ${req.method}` },
            });
            return;
        }
        try {
            const result = await handler(req.params ?? {});
            // For notifications (no id) we deliberately do not respond.
            if (id !== null && id !== undefined) {
                write({ jsonrpc: '2.0', id, result });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('handler threw', { method: req.method, err: message });
            if (id !== null && id !== undefined) {
                write({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32000, message },
                });
            }
        }
    }

    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let parsed: JsonRpcRequest;
            try {
                parsed = JSON.parse(line);
            } catch (e) {
                write({
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32700, message: 'Parse error', data: String(e) },
                });
                continue;
            }
            if (!parsed || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
                write({
                    jsonrpc: '2.0',
                    id: parsed?.id ?? null,
                    error: { code: -32600, message: 'Invalid Request' },
                });
                continue;
            }
            void dispatch(parsed);
        }
    });

    process.stdin.on('end', () => {
        log.info('stdin closed, draining sessions');
        void closeAllSessions().finally(() => process.exit(0));
    });

    const shutdown = (sig: string) => {
        log.info('signal received, draining', { sig });
        void closeAllSessions().finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Signal readiness to the Rust parent — this lets ensure_spawned() detect
    // successful startup instead of waiting for the full RPC timeout.
    process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'sidecar.ready',
        params: { pid: process.pid, node: process.version },
    }) + '\n');

    log.info('sidecar ready', { pid: process.pid, node: process.version });
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'sidecar.error',
        params: { message },
    }) + '\n');
    process.exit(1);
});
