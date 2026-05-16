'use client';

/**
 * WorkflowReplayDialog — per-step replay with approval gating.
 *
 * Walks a workflow step-by-step:
 *   1. Loads parameter-bound steps via workflow_replay_bind.
 *   2. For each step: classifies it. Read steps run autonomously.
 *      Write/destructive steps stop on a confirmation card that shows
 *      the most recent observation's screenshot + a one-line intent.
 *   3. Dispatches via browser_rpc. Updates a step list with status icons.
 *   4. Stops on first failure (errors propagate to the user as-is).
 *
 * The cached observation is whichever `browser_observe` ran most recently
 * in the replay — the very first step in any browser workflow should be
 * `browser_open` followed by `browser_observe`, so by the time a write
 * step is reached we have something to show.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    makeStyles,
    tokens,
    Text,
    Button,
    Input,
    Spinner,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    DialogActions,
    DialogTrigger,
} from '@fluentui/react-components';
import {
    CheckmarkCircle16Filled,
    DismissCircle16Filled,
    ErrorCircle16Filled,
    ArrowSync16Regular,
    Pause16Regular,
} from '@fluentui/react-icons';
import {
    classifyBrowserAction,
    describeBrowserAction,
    type BrowserRisk,
} from '@/lib/ai/browser-classify';

interface WorkflowStep {
    tool: string; // "browser.open" / "browser.navigate" / etc.
    params: Record<string, unknown>;
    classification: string;
    observedUrl?: string;
    observedTitle?: string;
}

interface WorkflowParameterMeta {
    name: string;
    type: string;
    required: boolean;
}

interface WorkflowFile {
    name: string;
    slug: string;
    version: number;
    createdAt: string;
    modelUsed?: string | null;
    parameters: WorkflowParameterMeta[];
    steps: WorkflowStep[];
}

type StepStatus = 'pending' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied';

interface StepRuntimeState {
    status: StepStatus;
    error?: string;
    result?: Record<string, unknown>;
}

interface Props {
    slug: string;
    name: string;
    onClose: () => void;
}

const useStyles = makeStyles({
    paramRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        marginBottom: '8px',
    },
    stepList: {
        maxHeight: '320px',
        overflow: 'auto',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '6px',
    },
    stepRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        ':last-child': { borderBottom: 'none' },
    },
    stepIndex: {
        width: '24px',
        textAlign: 'center',
        color: tokens.colorNeutralForeground3,
        fontSize: '12px',
    },
    stepBody: {
        flex: 1,
        minWidth: '0px',
        display: 'flex',
        flexDirection: 'column',
    },
    classification: {
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
    },
    approvalCard: {
        marginTop: '12px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
    },
});

function StepIcon({ status }: { status: StepStatus }) {
    if (status === 'done') return <CheckmarkCircle16Filled color={tokens.colorPaletteGreenForeground1} />;
    if (status === 'error') return <ErrorCircle16Filled color={tokens.colorPaletteRedForeground1} />;
    if (status === 'denied') return <DismissCircle16Filled color={tokens.colorPaletteRedForeground1} />;
    if (status === 'running') return <ArrowSync16Regular />;
    if (status === 'awaiting_approval') return <Pause16Regular />;
    return <span style={{ width: 16, height: 16, display: 'inline-block', border: `2px solid ${tokens.colorNeutralStroke2}`, borderRadius: '50%' }} />;
}

function methodToToolName(method: string): string {
    return method.replace('browser.', 'browser_');
}

export function WorkflowReplayDialog({ slug, name, onClose }: Props) {
    const styles = useStyles();
    const [workflow, setWorkflow] = useState<WorkflowFile | null>(null);
    const [params, setParams] = useState<Record<string, string>>({});
    const [boundSteps, setBoundSteps] = useState<WorkflowStep[]>([]);
    const [stepStates, setStepStates] = useState<StepRuntimeState[]>([]);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [latestScreenshot, setLatestScreenshot] = useState<string | undefined>(undefined);
    const [latestUrl, setLatestUrl] = useState<string | undefined>(undefined);
    const [latestTags, setLatestTags] = useState<Record<number, string[]>>({});
    const [pendingApproval, setPendingApproval] = useState<{
        stepIndex: number;
        risk: BrowserRisk;
        intent: string;
        resolve: (ok: boolean) => void;
    } | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const wf = await invoke<WorkflowFile>('workflow_load', { slug });
                setWorkflow(wf);
            } catch (e) {
                setError(String(e));
            }
        })();
    }, [slug]);

    const allParamsFilled = useMemo(() => {
        if (!workflow) return false;
        return workflow.parameters
            .filter((p) => p.required)
            .every((p) => (params[p.name] ?? '').trim().length > 0);
    }, [workflow, params]);

    const runStep = useCallback(
        async (step: WorkflowStep, stepIndex: number): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
            const toolName = methodToToolName(step.tool);
            const risk = classifyBrowserAction({
                method: toolName,
                params: step.params,
                hints: { tags: step.params.tags as string[] | undefined },
            });
            if (risk === 'write' || risk === 'destructive') {
                setStepStates((prev) => {
                    const next = [...prev];
                    next[stepIndex] = { status: 'awaiting_approval' };
                    return next;
                });
                const approved = await new Promise<boolean>((resolve) => {
                    setPendingApproval({
                        stepIndex,
                        risk,
                        intent: describeBrowserAction(
                            { method: toolName, params: step.params },
                            step.observedUrl ?? latestUrl,
                        ),
                        resolve,
                    });
                });
                setPendingApproval(null);
                if (!approved) {
                    return { ok: false, error: 'Denied by user' };
                }
            }
            setStepStates((prev) => {
                const next = [...prev];
                next[stepIndex] = { status: 'running' };
                return next;
            });
            try {
                const result = await invoke<Record<string, unknown>>('browser_rpc', {
                    request: { method: step.tool, params: step.params },
                });
                // Cache screenshot from browser.observe results so subsequent
                // write-step approvals can render the live page.
                if (step.tool === 'browser.observe') {
                    const screenshot = (result as { screenshot?: string }).screenshot;
                    if (screenshot) setLatestScreenshot(screenshot);
                    const url = (result as { url?: string }).url;
                    if (url) setLatestUrl(url);
                }
                return { ok: true, result };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
        [latestUrl],
    );

    const run = useCallback(async () => {
        if (!workflow) return;
        setRunning(true);
        setError(null);
        try {
            const parameters: Record<string, unknown> = {};
            for (const p of workflow.parameters) parameters[p.name] = params[p.name];
            const bound = await invoke<WorkflowStep[]>('workflow_replay_bind', {
                slug,
                parameters,
            });
            setBoundSteps(bound);
            setStepStates(bound.map(() => ({ status: 'pending' })));
            for (let i = 0; i < bound.length; i++) {
                const r = await runStep(bound[i], i);
                setStepStates((prev) => {
                    const next = [...prev];
                    if (r.ok) {
                        next[i] = { status: 'done', result: r.result as Record<string, unknown> };
                    } else if (r.error === 'Denied by user') {
                        next[i] = { status: 'denied', error: r.error };
                    } else {
                        next[i] = { status: 'error', error: r.error };
                    }
                    return next;
                });
                if (!r.ok) break;
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setRunning(false);
        }
    }, [workflow, params, slug, runStep]);

    return (
        <Dialog open={true} onOpenChange={(_, data) => { if (!data.open) onClose(); }} modalType="modal">
            <DialogSurface style={{ minWidth: 540, maxWidth: 720 }}>
                <DialogBody>
                    <DialogTitle>Replay workflow: {name}</DialogTitle>
                    <DialogContent>
                        {!workflow && !error && <Spinner size="small" />}
                        {error && (
                            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                {error}
                            </Text>
                        )}
                        {workflow && (
                            <>
                                {workflow.parameters.length > 0 && (
                                    <div style={{ marginBottom: 12 }}>
                                        <Text weight="semibold">Parameters</Text>
                                        {workflow.parameters.map((p) => (
                                            <div key={p.name} className={styles.paramRow}>
                                                <Text size={200}>
                                                    {p.name}{p.required ? ' *' : ''}
                                                </Text>
                                                <Input
                                                    value={params[p.name] ?? ''}
                                                    onChange={(_, data) => setParams((prev) => ({ ...prev, [p.name]: data.value }))}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <Text weight="semibold">Steps ({workflow.steps.length})</Text>
                                <div className={styles.stepList} style={{ marginTop: 6 }}>
                                    {(boundSteps.length ? boundSteps : workflow.steps).map((step, i) => {
                                        const state = stepStates[i] ?? { status: 'pending' as const };
                                        return (
                                            <div key={i} className={styles.stepRow}>
                                                <span className={styles.stepIndex}>{i + 1}</span>
                                                <StepIcon status={state.status} />
                                                <div className={styles.stepBody}>
                                                    <Text size={200}>
                                                        {methodToToolName(step.tool)}
                                                        {step.params.url ? ` → ${step.params.url}` : ''}
                                                        {step.params.action ? ` (${step.params.action})` : ''}
                                                    </Text>
                                                    <span className={styles.classification}>{step.classification}</span>
                                                    {state.error && (
                                                        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                                            {state.error}
                                                        </Text>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {pendingApproval && (
                                    <div className={styles.approvalCard}>
                                        <Text weight="semibold">
                                            Confirm step {pendingApproval.stepIndex + 1} — {pendingApproval.risk}
                                        </Text>
                                        <Text size={200} style={{ display: 'block', marginTop: 4 }}>
                                            {pendingApproval.intent}
                                        </Text>
                                        {latestScreenshot && (
                                            <img
                                                src={`data:image/jpeg;base64,${latestScreenshot}`}
                                                alt="latest observation"
                                                style={{
                                                    display: 'block',
                                                    width: '100%',
                                                    maxHeight: 240,
                                                    objectFit: 'contain',
                                                    marginTop: 8,
                                                    background: tokens.colorNeutralBackground1,
                                                    borderRadius: 4,
                                                }}
                                            />
                                        )}
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                                            <Button onClick={() => pendingApproval.resolve(false)}>Deny</Button>
                                            <Button
                                                appearance="primary"
                                                style={pendingApproval.risk === 'destructive'
                                                    ? { backgroundColor: '#d13438', color: 'white' } as React.CSSProperties
                                                    : undefined}
                                                onClick={() => pendingApproval.resolve(true)}
                                            >
                                                {pendingApproval.risk === 'destructive' ? 'Proceed Anyway' : 'Approve'}
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </DialogContent>
                    <DialogActions>
                        <DialogTrigger disableButtonEnhancement>
                            <Button appearance="secondary" onClick={onClose}>Close</Button>
                        </DialogTrigger>
                        <Button
                            appearance="primary"
                            disabled={!workflow || running || !allParamsFilled}
                            onClick={run}
                        >
                            {running ? 'Replaying…' : boundSteps.length ? 'Re-run' : 'Run'}
                        </Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
}

export default WorkflowReplayDialog;
