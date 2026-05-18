'use client';

/**
 * WorkflowReplayDialog — per-step replay with approval gating.
 *
 * Walks a workflow step-by-step:
 *   1. Loads parameter-bound steps via workflow_replay_bind.
 *   2. All browser.open steps are forced to headed:true so the user always
 *      sees a real browser window.
 *   3. For each step: classifies it. Read steps run autonomously.
 *      Write/destructive steps stop on a confirmation card.
 *   4. The user can pause the replay at any time ("Take over") to handle
 *      logins, CAPTCHAs, or 2FA in the headed window, then click Resume.
 *   5. When a step errors (auth wall, CAPTCHA, etc.) the replay pauses
 *      automatically — fix it in the browser, then click "Resume from
 *      next step".
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    Person16Regular,
} from '@fluentui/react-icons';
import {
    classifyBrowserAction,
    describeBrowserAction,
    type BrowserRisk,
} from '@/lib/ai/browser-classify';

interface WorkflowStep {
    tool: string;
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

type StepStatus = 'pending' | 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied' | 'skipped';

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
        maxHeight: '280px',
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
    actionCard: {
        marginTop: '12px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
    },
    humanCard: {
        marginTop: '12px',
        border: `1px solid ${tokens.colorPaletteBlueBorderActive}`,
        borderRadius: '8px',
        padding: '12px',
        background: '#f0f6ff',
    },
    errorCard: {
        marginTop: '12px',
        border: `1px solid ${tokens.colorPaletteRedBorder2}`,
        borderRadius: '8px',
        padding: '12px',
        background: '#fff0f0',
    },
});

function StepIcon({ status }: { status: StepStatus }) {
    if (status === 'done') return <CheckmarkCircle16Filled color={tokens.colorPaletteGreenForeground1} />;
    if (status === 'error') return <ErrorCircle16Filled color={tokens.colorPaletteRedForeground1} />;
    if (status === 'denied' || status === 'skipped') return <DismissCircle16Filled color={tokens.colorNeutralForeground3} />;
    if (status === 'running') return <ArrowSync16Regular />;
    if (status === 'awaiting_approval') return <Pause16Regular />;
    return <span style={{ width: 16, height: 16, display: 'inline-block', border: `2px solid ${tokens.colorNeutralStroke2}`, borderRadius: '50%' }} />;
}

function methodToToolName(method: string): string {
    return method.replace('browser.', 'browser_');
}

/** Force every browser.open step to open a visible (headed) window so the
 *  user can always see what's happening and take over for auth/CAPTCHA. */
function applyReplayOverrides(steps: WorkflowStep[]): WorkflowStep[] {
    return steps.map((s) =>
        s.tool === 'browser.open'
            ? { ...s, params: { ...s.params, headed: true } }
            : s,
    );
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

    // Approval state for write/destructive steps.
    const [pendingApproval, setPendingApproval] = useState<{
        stepIndex: number;
        risk: BrowserRisk;
        intent: string;
        resolve: (ok: boolean) => void;
    } | null>(null);

    // Human takeover state — pauses the loop until the user clicks Resume.
    // resolve() advances to the next step; the ref escapes the closure.
    const humanResumeRef = useRef<((skipStep: boolean) => void) | null>(null);
    const [humanMode, setHumanMode] = useState<'paused' | 'error-recovery' | null>(null);
    const [humanMessage, setHumanMessage] = useState('');

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

    // Notify page.tsx so it can show the BrowserView split.
    useEffect(() => {
        return () => {
            window.dispatchEvent(new CustomEvent('workflow-replay-stopped'));
        };
    }, []);

    const allParamsFilled = useMemo(() => {
        if (!workflow) return false;
        return workflow.parameters
            .filter((p) => p.required)
            .every((p) => (params[p.name] ?? '').trim().length > 0);
    }, [workflow, params]);

    /** Pause the replay loop until the user clicks Resume or Skip. */
    const waitForHuman = useCallback((message: string, mode: 'paused' | 'error-recovery'): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            humanResumeRef.current = resolve;
            setHumanMessage(message);
            setHumanMode(mode);
        });
    }, []);

    const handleResume = useCallback((skipStep: boolean) => {
        const resolve = humanResumeRef.current;
        humanResumeRef.current = null;
        setHumanMode(null);
        setHumanMessage('');
        resolve?.(skipStep);
    }, []);

    const handleTakeOver = useCallback(() => {
        waitForHuman(
            'Browser handed to you. Complete any login, CAPTCHA, or 2FA in the browser window, then click Resume.',
            'paused',
        );
    }, [waitForHuman]);

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
        window.dispatchEvent(new CustomEvent('workflow-replay-started'));
        try {
            const parameters: Record<string, unknown> = {};
            for (const p of workflow.parameters) parameters[p.name] = params[p.name];
            const raw = await invoke<WorkflowStep[]>('workflow_replay_bind', { slug, parameters });
            // Force headed mode so the browser window is always visible.
            const bound = applyReplayOverrides(raw);
            setBoundSteps(bound);
            setStepStates(bound.map(() => ({ status: 'pending' })));

            for (let i = 0; i < bound.length; i++) {
                const r = await runStep(bound[i], i);
                if (r.ok) {
                    setStepStates((prev) => {
                        const next = [...prev];
                        next[i] = { status: 'done', result: r.result as Record<string, unknown> };
                        return next;
                    });
                } else if (r.error === 'Denied by user') {
                    setStepStates((prev) => {
                        const next = [...prev];
                        next[i] = { status: 'denied', error: r.error };
                        return next;
                    });
                    break;
                } else {
                    // Step failed — pause for human recovery instead of aborting.
                    setStepStates((prev) => {
                        const next = [...prev];
                        next[i] = { status: 'error', error: r.error };
                        return next;
                    });
                    const shouldSkip = await waitForHuman(
                        `Step ${i + 1} failed: ${r.error ?? 'unknown error'}. Fix it in the browser window (e.g. log in, solve CAPTCHA), then click "Resume from next step" — or click "Stop" to abort.`,
                        'error-recovery',
                    );
                    if (!shouldSkip) break; // Stop clicked
                    // Mark the failed step as skipped and continue from i+1.
                    setStepStates((prev) => {
                        const next = [...prev];
                        next[i] = { status: 'skipped', error: r.error };
                        return next;
                    });
                }
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setRunning(false);
            window.dispatchEvent(new CustomEvent('workflow-replay-stopped'));
        }
    }, [workflow, params, slug, runStep, waitForHuman]);

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
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <Text weight="semibold">Steps ({workflow.steps.length})</Text>
                                    {running && !humanMode && (
                                        <Button
                                            size="small"
                                            appearance="subtle"
                                            icon={<Person16Regular />}
                                            onClick={handleTakeOver}
                                        >
                                            Take over
                                        </Button>
                                    )}
                                </div>
                                <div className={styles.stepList}>
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
                                                    {state.status === 'error' && state.error && (
                                                        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                                            {state.error}
                                                        </Text>
                                                    )}
                                                    {state.status === 'skipped' && (
                                                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                                            Skipped (fixed manually)
                                                        </Text>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Human takeover / error recovery card */}
                                {humanMode && (
                                    <div className={humanMode === 'error-recovery' ? styles.errorCard : styles.humanCard}>
                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                            <Person16Regular style={{ flexShrink: 0, marginTop: 2 }} />
                                            <Text size={200} style={{ flex: 1 }}>{humanMessage}</Text>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                                            <Button size="small" onClick={() => handleResume(false)}>Stop</Button>
                                            <Button size="small" appearance="primary" onClick={() => handleResume(true)}>
                                                {humanMode === 'error-recovery' ? 'Resume from next step' : 'Resume'}
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                {/* Write/destructive step approval card */}
                                {pendingApproval && (
                                    <div className={styles.actionCard}>
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
