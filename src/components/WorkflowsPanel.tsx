'use client';

// WorkflowsPanel — lists saved workflows, controls recording, and surfaces
// incomplete runs for resumption. Recording now goes through a review step
// (WorkflowRecordingReview) before saving so the user can label step intents,
// confirm actor classifications, and approve variable parameterisation.

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    makeStyles,
    tokens,
    Text,
    Button,
    Input,
    Spinner,
    Badge,
    Switch,
} from '@fluentui/react-components';
import {
    Warning20Regular,
    Record16Regular,
    Stop16Regular,
    Play16Regular,
    Edit16Regular,
    Delete16Regular,
    ArrowClockwise16Regular,
    Clock20Regular,
} from '@fluentui/react-icons';
import WorkflowRunPanel from './WorkflowRunPanel';
import { WorkflowRecordingReview } from './WorkflowRecordingReview';
import { WorkflowEditor } from './WorkflowEditor';
import { SchedulePanel } from './SchedulePanel';
import type { WorkflowStepV1, WorkflowFileV2, WorkflowRun, WorkflowSchedule } from '@/types/workflow-types';
import type { ModelConfig } from '@/types/ai-types';
import { useModelConfig } from '@/lib/ModelConfigContext';

interface WorkflowSummary {
    name: string;
    slug: string;
    description?: string;
    schedule?: string;
    createdAt: string;
    stepCount: number;
    variableCount: number;
    version: number;
    path: string;
}

interface RecordingStatus {
    name: string;
    startedAt: string;
    stepCount: number;
}

interface Props {
    modelConfig?: ModelConfig | null;
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

export function WorkflowsPanel({ modelConfig: modelConfigProp }: Props) {
    const styles = useStyles();
    const { modelConfig: sharedModelConfig } = useModelConfig();
    const modelConfig = modelConfigProp ?? sharedModelConfig;
    const [list, setList] = useState<WorkflowSummary[]>([]);
    const [incompleteRuns, setIncompleteRuns] = useState<WorkflowRun[]>([]);
    const [status, setStatus] = useState<RecordingStatus | null>(null);
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [replaying, setReplaying] = useState<{ slug: string; name: string; variables?: Record<string, unknown> } | null>(null);
    // Raw steps captured during recording — held until review dialog is dismissed
    const [pendingReview, setPendingReview] = useState<{ steps: WorkflowStepV1[]; name: string } | null>(null);
    // Full workflow being edited in the cell editor
    const [editing, setEditing] = useState<WorkflowFileV2 | null>(null);

    // Schedule management + filter
    const [schedules, setSchedules] = useState<Map<string, WorkflowSchedule>>(new Map());
    const [schedulePanelSlug, setSchedulePanelSlug] = useState<string | null>(null);
    const [filterScheduled, setFilterScheduled] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const [rows, recordingStatus, runs, scheds] = await Promise.all([
                invoke<WorkflowSummary[]>('workflow_list'),
                invoke<RecordingStatus | null>('workflow_recording_status'),
                invoke<WorkflowRun[]>('workflow_run_list_incomplete'),
                invoke<WorkflowSchedule[]>('workflow_schedule_list'),
            ]);
            setList(rows);
            setStatus(recordingStatus);
            setIncompleteRuns(runs);
            setSchedules(new Map(scheds.map(s => [s.workflowSlug, s])));
        } catch (e) {
            setError(String(e));
        }
    }, []);

    useEffect(() => {
        refresh();
        const id = window.setInterval(refresh, 2_000);
        return () => window.clearInterval(id);
    }, [refresh]);

    // Listen for agent-triggered workflow launches (from run_workflow tool)
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { slug: string; variables?: Record<string, unknown> };
            if (!detail?.slug) return;
            const found = list.find((w) => w.slug === detail.slug);
            setReplaying({ slug: detail.slug, name: found?.name ?? detail.slug, variables: detail.variables });
        };
        window.addEventListener('workflow:run', handler);
        return () => window.removeEventListener('workflow:run', handler);
    }, [list]);

    const start = useCallback(async () => {
        const trimmed = name.trim();
        if (!trimmed) { setError('Workflow name is required.'); return; }
        setLoading(true);
        setError(null);
        try {
            await invoke('workflow_recording_start', { name: trimmed, modelUsed: modelConfig?.modelId ?? null });
            setName('');
            window.dispatchEvent(new CustomEvent('workflow-recording-started'));
            await refresh();
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, [name, modelConfig, refresh]);

    const stop = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // workflow_recording_stop returns the WorkflowFile (v1) with captured steps
            const result = await invoke<{ name: string; steps: WorkflowStepV1[] } | null>('workflow_recording_stop');
            window.dispatchEvent(new CustomEvent('workflow-recording-stopped'));
            if (result && result.steps.length > 0) {
                // Open review dialog instead of saving immediately
                setPendingReview({ steps: result.steps, name: result.name });
            }
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

    const edit = useCallback(async (slug: string) => {
        try {
            const wf = await invoke<WorkflowFileV2>('workflow_load', { slug });
            setEditing(wf);
        } catch (e) {
            setError(String(e));
        }
    }, []);

    const handleEditorSaved = useCallback(async (_wf: WorkflowFileV2) => {
        setEditing(null);
        await refresh();
    }, [refresh]);

    const handleReviewSaved = useCallback(async (_wf: WorkflowFileV2) => {
        setPendingReview(null);
        await refresh();
    }, [refresh]);

    const toggleSchedule = useCallback(async (slug: string, current: WorkflowSchedule | undefined) => {
        if (!current) return;
        const newEnabled = !current.enabled;
        await invoke('workflow_schedule_toggle', { workflowSlug: slug, enabled: newEnabled });
        setSchedules(prev => {
            const next = new Map(prev);
            next.set(slug, { ...current, enabled: newEnabled });
            return next;
        });
    }, []);

    return (
        <div className={styles.root}>
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
                                Stop & review
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
                {/* Filter toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 6px' }}>
                    <Button
                        size="small"
                        appearance={!filterScheduled ? 'primary' : 'subtle'}
                        onClick={() => setFilterScheduled(false)}
                    >
                        All
                    </Button>
                    <Button
                        size="small"
                        appearance={filterScheduled ? 'primary' : 'subtle'}
                        onClick={() => setFilterScheduled(true)}
                        icon={<Clock20Regular />}
                    >
                        Scheduled
                    </Button>
                </div>

                {/* Incomplete runs — show at the top so user can resume */}
                {incompleteRuns.length > 0 && (
                    <>
                        <Text size={200} weight="semibold" style={{ color: tokens.colorNeutralForeground2, padding: '2px 0 4px' }}>
                            Incomplete runs
                        </Text>
                        {incompleteRuns.map((run) => (
                            <div key={run.runId} className={styles.row} style={{ borderColor: tokens.colorPaletteBlueBorderActive }}>
                                <div className={styles.rowInfo}>
                                    <Text weight="semibold">{run.workflowSlug}</Text>
                                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                        {run.status} · started {run.startedAt.slice(0, 10)}
                                        {run.pausedAtStep != null ? ` · paused at step ${run.pausedAtStep + 1}` : ''}
                                    </Text>
                                </div>
                                <Button
                                    appearance="subtle"
                                    icon={<ArrowClockwise16Regular />}
                                    onClick={() => setReplaying({ slug: run.workflowSlug, name: run.workflowSlug })}
                                    disabled={loading}
                                >
                                    Resume
                                </Button>
                                <Button
                                    appearance="subtle"
                                    icon={<Delete16Regular />}
                                    title="Discard this incomplete run"
                                    onClick={() => {
                                        invoke('workflow_run_complete', { runId: run.runId, status: 'cancelled' })
                                            .catch(() => {});
                                        setIncompleteRuns((prev) => prev.filter((r) => r.runId !== run.runId));
                                    }}
                                />
                            </div>
                        ))}
                        <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, margin: '4px 0 8px' }} />
                    </>
                )}

                {list.length === 0 && incompleteRuns.length === 0 ? (
                    <div className={styles.empty}>
                        <Text>
                            No workflows recorded yet. Start a recording, ask the agent to perform a
                            browser task, then click <strong>Stop &amp; review</strong> to label and save it.
                        </Text>
                    </div>
                ) : (
                    list
                        .filter(wf => !filterScheduled || wf.schedule)
                        .map((wf) => {
                        const sched = schedules.get(wf.slug);
                        const hasIncompleteRun = incompleteRuns.some(r => r.workflowSlug === wf.slug);
                        return (
                            <div key={wf.slug} className={styles.row}>
                                <div className={styles.rowInfo}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Text weight="semibold">{wf.name}</Text>
                                        {wf.version === 2 && (
                                            <Badge appearance="tint" color="brand" size="small">v2</Badge>
                                        )}
                                        {hasIncompleteRun && (
                                            <Badge appearance="filled" color="warning" size="small">running</Badge>
                                        )}
                                        {sched && sched.enabled && (
                                            <Badge appearance="outline" color="brand" size="small" icon={<Clock20Regular />}>scheduled</Badge>
                                        )}
                                    </div>
                                    {wf.description && (
                                        <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                                            {wf.description}
                                        </Text>
                                    )}
                                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                        {wf.stepCount} step{wf.stepCount === 1 ? '' : 's'}
                                        {wf.variableCount > 0 ? ` · ${wf.variableCount} variable${wf.variableCount === 1 ? '' : 's'}` : ''}
                                        {' · '}{wf.createdAt.slice(0, 10)}
                                        {sched?.nextRunAt && sched.enabled ? ` · next: ${new Date(sched.nextRunAt).toLocaleDateString()}` : ''}
                                    </Text>
                                </div>
                                {sched && (
                                    <Switch
                                        checked={sched.enabled}
                                        onChange={() => toggleSchedule(wf.slug, sched)}
                                        label={sched.enabled ? 'On' : 'Off'}
                                        style={{ minWidth: 60 }}
                                    />
                                )}
                                <Button
                                    appearance="subtle"
                                    icon={<Edit16Regular />}
                                    onClick={() => edit(wf.slug)}
                                    disabled={loading}
                                    title="Edit workflow steps"
                                    style={{ minWidth: 0 }}
                                />
                                <Button
                                    appearance="subtle"
                                    icon={<Clock20Regular />}
                                    onClick={() => setSchedulePanelSlug(wf.slug)}
                                    disabled={loading}
                                    title={sched ? 'Edit schedule' : 'Add schedule'}
                                    style={{ minWidth: 0 }}
                                />
                                <Button
                                    appearance="subtle"
                                    icon={<Play16Regular />}
                                    onClick={() => setReplaying({ slug: wf.slug, name: wf.name })}
                                    disabled={loading}
                                >
                                    Run
                                </Button>
                                <Button
                                    appearance="subtle"
                                    icon={<Delete16Regular />}
                                    onClick={() => remove(wf.slug)}
                                    disabled={loading}
                                />
                            </div>
                        );
                    })
                )}
            </div>

            {replaying && (
                <WorkflowRunPanel
                    slug={replaying.slug}
                    name={replaying.name}
                    initialVariables={replaying.variables}
                    modelConfig={modelConfig}
                    onClose={() => setReplaying(null)}
                />
            )}

            {pendingReview && (
                <WorkflowRecordingReview
                    rawSteps={pendingReview.steps}
                    initialName={pendingReview.name}
                    modelConfig={modelConfig ?? null}
                    onSaved={handleReviewSaved}
                    onCancel={() => setPendingReview(null)}
                />
            )}

            {editing && (
                <WorkflowEditor
                    workflow={editing}
                    onSaved={handleEditorSaved}
                    onCancel={() => setEditing(null)}
                />
            )}

            {schedulePanelSlug && (
                <SchedulePanel
                    workflowSlug={schedulePanelSlug}
                    workflowName={list.find(w => w.slug === schedulePanelSlug)?.name ?? schedulePanelSlug}
                    open={true}
                    onClose={() => { setSchedulePanelSlug(null); refresh(); }}
                />
            )}
        </div>
    );
}

export default WorkflowsPanel;
