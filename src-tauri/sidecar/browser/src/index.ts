// JSON-RPC 2.0 dispatcher for the browser-use sidecar.
//
// Reads newline-delimited JSON-RPC frames on stdin, writes responses on
// stdout, logs to stderr. Concurrent requests are allowed — each frame's
// `id` is echoed back on the matching response.

import { handleOpen } from './handlers/open.js';
import { handleNavigate } from './handlers/navigate.js';
import { handleObserve } from './handlers/observe.js';
import { handleClose } from './handlers/close.js';
import { handleAct } from './handlers/act.js';
import { handleExtract } from './handlers/extract.js';
import { closeAllSessions } from './sessions.js';
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
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

const HANDLERS: Record<string, (params: any) => Promise<unknown>> = {
    'browser.ping': async () => ({ ok: true, pid: process.pid }),
    'browser.open': handleOpen,
    'browser.navigate': handleNavigate,
    'browser.observe': handleObserve,
    'browser.act': handleAct,
    'browser.extract': handleExtract,
    'browser.close': handleClose,
};

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

function bootstrap(): void {
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

    log.info('sidecar ready', { pid: process.pid, node: process.version });
}

bootstrap();
