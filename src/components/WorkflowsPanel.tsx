'use client';

/**
 * WorkflowsPanel — RPA capability seam (M4).
 *
 * Lists recorded workflows under ~/.ittoolkit/workflows/ and exposes
 * record / stop / replay controls. Empty by default — no pre-shipped
 * workflows. The user records a session by clicking Start, performing
 * the task once (the agent's browser_rpc calls are captured), clicking
 * Stop, and providing a name.
 *
 * Trust model in M4: replay actions auto-approve. A signed-skill flow
 * with per-action approval arrives in a later milestone.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    makeStyles,
    tokens,
    Text,
    Button,
    Input,
    Spinner,
} from '@fluentui/react-components';
import { Warning20Regular, Record16Regular, Stop16Regular, Play16Regular, Delete16Regular } from '@fluentui/react-icons';
import { WorkflowReplayDialog } from './WorkflowReplayDialog';

interface WorkflowSummary {
    name: string;
    slug: string;
    createdAt: string;
    stepCount: number;
    path: string;
}

interface RecordingStatus {
    name: string;
    startedAt: string;
    stepCount: number;
}

const useStyles = makeStyles({
    root: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: tokens.colorNeutralBackground1,
        color: tokens.colorNeutralForeground1,
    },
    banner: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '10px 14px',
        background: '#fff8db',
        color: '#574100',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        fontSize: '12px',
    },
    header: {
        padding: '10px 14px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    recordingRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
    },
    list: {
        flex: 1,
        overflow: 'auto',
        padding: '8px 12px',
    },
    empty: {
        textAlign: 'center',
        padding: '60px 20px',
        color: tokens.colorNeutralForeground3,
    },
    row: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 10px',
        borderRadius: '6px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        marginBottom: '8px',
    },
    rowInfo: {
        flex: 1,
        minWidth: '0px',
        display: 'flex',
        flexDirection: 'column',
    },
});

export function WorkflowsPanel() {
    const styles = useStyles();
    const [list, setList] = useState<WorkflowSummary[]>([]);
    const [status, setStatus] = useState<RecordingStatus | null>(null);
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [replaying, setReplaying] = useState<{ slug: string; name: string } | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [rows, recordingStatus] = await Promise.all([
                invoke<WorkflowSummary[]>('workflow_list'),
                invoke<RecordingStatus | null>('workflow_recording_status'),
            ]);
            setList(rows);
            setStatus(recordingStatus);
        } catch (e) {
            setError(String(e));
        }
    }, []);

    useEffect(() => {
        refresh();
        const id = window.setInterval(refresh, 2_000); // polling step counter
        return () => window.clearInterval(id);
    }, [refresh]);

    const start = useCallback(async () => {
        const trimmed = name.trim();
        if (!trimmed) {
            setError('Workflow name is required.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await invoke('workflow_recording_start', { name: trimmed, modelUsed: null });
            setName('');
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [name, refresh]);

    const stop = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            await invoke('workflow_recording_stop');
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [refresh]);

    const remove = useCallback(async (slug: string) => {
        setLoading(true);
        setError(null);
        try {
            await invoke('workflow_delete', { slug });
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [refresh]);

    return (
        <div className={styles.root}>
            <div className={styles.banner}>
                <Warning20Regular fontSize={16} style={{ flexShrink: 0 }} />
                <span>
                    Workflows are an early-access capability. Replay does not yet enforce per-step
                    approval — only run workflows you recorded yourself and trust end-to-end.
                </span>
            </div>
            <div className={styles.header}>
                <Text weight="semibold">Recording</Text>
                <div className={styles.recordingRow}>
                    {status ? (
                        <>
                            <Spinner size="tiny" />
                            <Text>
                                Recording <strong>{status.name}</strong> — {status.stepCount} step
                                {status.stepCount === 1 ? '' : 's'} captured.
                            </Text>
                            <Button
                                appearance="primary"
                                icon={<Stop16Regular />}
                                onClick={stop}
                                disabled={loading}
                                style={{ marginLeft: 'auto' }}
                            >
                                Stop & save
                            </Button>
                        </>
                    ) : (
                        <>
                            <Input
                                value={name}
                                onChange={(_, data) => setName(data.value)}
                                placeholder="Workflow name (e.g. okta-unlock-user)"
                                style={{ flex: 1 }}
                            />
                            <Button
                                appearance="primary"
                                icon={<Record16Regular />}
                                onClick={start}
                                disabled={loading || !name.trim()}
                            >
                                Start recording
                            </Button>
                        </>
                    )}
                </div>
                {error && (
                    <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                        {error}
                    </Text>
                )}
            </div>
            <div className={styles.list}>
                {list.length === 0 ? (
                    <div className={styles.empty}>
                        <Text>
                            No workflows recorded yet. Start a recording, ask the agent to perform a
                            browser task, then click <strong>Stop &amp; save</strong> to capture it.
                        </Text>
                    </div>
                ) : (
                    list.map((wf) => (
                        <div key={wf.slug} className={styles.row}>
                            <div className={styles.rowInfo}>
                                <Text weight="semibold">{wf.name}</Text>
                                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                    {wf.stepCount} step{wf.stepCount === 1 ? '' : 's'} · created {wf.createdAt.slice(0, 10)}
                                </Text>
                            </div>
                            <Button
                                appearance="subtle"
                                icon={<Play16Regular />}
                                onClick={() => setReplaying({ slug: wf.slug, name: wf.name })}
                                disabled={loading}
                            >
                                Replay
                            </Button>
                            <Button
                                appearance="subtle"
                                icon={<Delete16Regular />}
                                onClick={() => remove(wf.slug)}
                                disabled={loading}
                            />
                        </div>
                    ))
                )}
            </div>
            {replaying && (
                <WorkflowReplayDialog
                    slug={replaying.slug}
                    name={replaying.name}
                    onClose={() => setReplaying(null)}
                />
            )}
        </div>
    );
}

export default WorkflowsPanel;
