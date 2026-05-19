'use client';

/**
 * BrowserView — main-pane viewport for the browser-use harness.
 *
 * Subscribes to `browser-frame` Tauri events (notifications from the
 * Playwright sidecar) and renders the latest screenshot. In Phase 1 this
 * panel is read-only; Phase 2 will accept pointer events.
 *
 * Also listens for `browser-observe` previews routed through the inline
 * chat surface so the last screenshot stays visible after the model has
 * moved on to other steps.
 */

import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { makeStyles, tokens, Text, Button, Spinner } from '@fluentui/react-components';

interface ViewportState {
    sessionId?: string;
    url?: string;
    title?: string;
    screenshot?: string;
    receivedAt?: number;
}

const useStyles = makeStyles({
    root: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: tokens.colorNeutralBackground1,
        color: tokens.colorNeutralForeground1,
    },
    header: {
        padding: '10px 14px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexShrink: 0,
    },
    headerInfo: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: '0px',
    },
    body: {
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '16px',
        background: tokens.colorNeutralBackground2,
    },
    screenshot: {
        maxWidth: '100%',
        maxHeight: '100%',
        objectFit: 'contain',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        background: 'white',
    },
    empty: {
        color: tokens.colorNeutralForeground3,
        textAlign: 'center',
        maxWidth: '480px',
        padding: '40px 20px',
    },
    pill: {
        background: tokens.colorNeutralBackground3,
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        color: tokens.colorNeutralForeground2,
        whiteSpace: 'nowrap',
    },
});

export function BrowserView() {
    const styles = useStyles();
    const [state, setState] = useState<ViewportState>({});
    const [setupMessage, setSetupMessage] = useState<string | null>(null);

    useEffect(() => {
        // Notifications from the sidecar (live frame stream — not used in
        // M1 by the sidecar but the channel is wired for future use).
        const unlisten1 = listen<{ method: string; params: Record<string, unknown> }>(
            'browser-frame',
            (event) => {
                const { method, params } = event.payload ?? ({} as any);
                if (method === 'browser.frame' && typeof params?.jpeg === 'string') {
                    setState((prev) => ({
                        ...prev,
                        sessionId: (params.session_id as string | undefined) ?? prev.sessionId,
                        url: (params.url as string | undefined) || prev.url,
                        screenshot: params.jpeg as string,
                        receivedAt: Date.now(),
                    }));
                } else if (method === 'sidecar.progress' && typeof params?.message === 'string') {
                    setSetupMessage(params.message as string);
                }
            },
        );

        // Observe results from the chat-side dispatch — broadcast via a
        // custom event so we don't couple this view to AIPanel imports.
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as {
                sessionId?: string;
                url?: string;
                title?: string;
                screenshot?: string;
            };
            if (!detail?.screenshot) return;
            setState({
                sessionId: detail.sessionId,
                url: detail.url,
                title: detail.title,
                screenshot: detail.screenshot,
                receivedAt: Date.now(),
            });
        };
        window.addEventListener('browser-view-update', handler as EventListener);

        return () => {
            unlisten1.then((u) => u());
            window.removeEventListener('browser-view-update', handler as EventListener);
        };
    }, []);

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <div className={styles.headerInfo}>
                    <Text weight="semibold">Browser</Text>
                    {state.url ? (
                        <>
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3, wordBreak: 'break-all' }}>
                                {state.url}
                            </Text>
                            {state.title && <Text size={200}>{state.title}</Text>}
                        </>
                    ) : (
                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                            No active browser session.
                        </Text>
                    )}
                </div>
                {state.sessionId && <span className={styles.pill}>{state.sessionId}</span>}
            </div>
            <div className={styles.body}>
                {state.screenshot ? (
                    <img
                        src={`data:image/jpeg;base64,${state.screenshot}`}
                        alt={state.title ?? 'browser screenshot'}
                        className={styles.screenshot}
                    />
                ) : setupMessage ? (
                    <div className={styles.empty} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                        <Spinner size="medium" />
                        <Text>{setupMessage}</Text>
                    </div>
                ) : (
                    <div className={styles.empty}>
                        <Text>
                            The agent has not opened a browser session yet. Ask it to perform a web task
                            (e.g. <em>"Open https://example.com and tell me the page title"</em>) and the
                            screenshot will appear here.
                        </Text>
                    </div>
                )}
            </div>
        </div>
    );
}

export default BrowserView;
