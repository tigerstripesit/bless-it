'use client';

/**
 * WorkflowReplayDialog — floating, draggable, minimizable replay panel.
 *
 * Rendered as a position:fixed panel (not a modal) so the user can drag it
 * out of the way and keep watching the BrowserView during replay. Collapses
 * to a slim title bar when minimized.
 *
 * Replay behaviour:
 *   1. All browser.open steps are forced to headed:true.
 *   2. Read steps run autonomously; write/destructive steps pause for approval.
 *   3. "Take over" hands the browser to the user (login, CAPTCHA, 2FA).
 *   4. Step errors auto-pause with a "Resume from next step" option.
 *   5. Human-paced delays (±20% jitter) between steps.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { makeStyles, tokens, Text, Button, Input, Spinner } from '@fluentui/react-components';
import {
    CheckmarkCircle16Filled,
    DismissCircle16Filled,
    ErrorCircle16Filled,
    ArrowSync16Regular,
    Pause16Regular,
    Person16Regular,
    ChevronDown16Regular,
    ChevronUp16Regular,
    Dismiss16Regular,
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

const PANEL_WIDTH = 540;
const PANEL_MIN_HEIGHT = 44; // title bar only

const useStyles = makeStyles({
    panel: {
        position: 'fixed',
        zIndex: 9000,
        width: `${PANEL_WIDTH}px`,
        borderRadius: '8px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.28)',
        border: `1px solid ${tokens.colorNeutralStroke1}`,
        background: tokens.colorNeutralBackground1,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
    },
    titleBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '0 8px 0 14px',
        height: `${PANEL_MIN_HEIGHT}px`,
        flexShrink: 0,
        background: tokens.colorNeutralBackground2,
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        cursor: 'grab',
        userSelect: 'none',
    },
    titleBarDragging: {
        cursor: 'grabbing',
    },
    body: {
        padding: '14px 16px 16px',
        overflowY: 'auto',
        maxHeight: 'calc(85vh - 44px)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    paramRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
    },
    stepList: {
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '6px',
        overflow: 'hidden',
    },
    stepRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '7px 10px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        ':last-child': { borderBottom: 'none' },
    },
    stepIndex: {
        width: '20px',
        textAlign: 'right',
        color: tokens.colorNeutralForeground3,
        fontSize: '12px',
        flexShrink: 0,
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
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
    },
    humanCard: {
        border: `1px solid ${tokens.colorPaletteBlueBorderActive}`,
        borderRadius: '8px',
        padding: '12px',
        background: '#eef5ff',
    },
    errorCard: {
        border: `1px solid ${tokens.colorPaletteRedBorder2}`,
        borderRadius: '8px',
        padding: '12px',
        background: '#fff0f0',
    },
    footer: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
        paddingTop: '4px',
        flexShrink: 0,
    },
});

function StepIcon({ status }: { status: StepStatus }) {
    if (status === 'done') return <CheckmarkCircle16Filled color={tokens.colorPaletteGreenForeground1} />;
    if (status === 'error') return <ErrorCircle16Filled color={tokens.colorPaletteRedForeground1} />;
    if (status === 'denied' || status === 'skipped') return <DismissCircle16Filled color={tokens.colorNeutralForeground3} />;
    if (status === 'running') return <ArrowSync16Regular />;
    if (status === 'awaiting_approval') return <Pause16Regular />;
    return (
        <span style={{
            width: 14, height: 14, flexShrink: 0,
            border: `2px solid ${tokens.colorNeutralStroke2}`,
            borderRadius: '50%', display: 'inline-block',
        }} />
    );
}

function methodToToolName(method: string): string {
    return method.replace('browser.', 'browser_');
}

function humanDelay(tool: string, params: Record<string, unknown>): Promise<void> {
    const jitter = 0.8 + Math.random() * 0.4;
    let base = 700;
    if (tool === 'browser.navigate') base = 1600;
    else if (tool === 'browser.open') base = 900;
    else if (tool === 'browser.act') {
        const action = params.action as string | undefined;
        base = (action === 'type' || action === 'fill') ? 650 : 950;
    } else if (tool === 'browser.observe') base = 500;
    else if (tool === 'browser.extract') base = 400;
    return new Promise((r) => setTimeout(r, Math.round(base * jitter)));
}

function applyReplayOverrides(steps: WorkflowStep[]): WorkflowStep[] {
    return steps.map((s) =>
        s.tool === 'browser.open' ? { ...s, params: { ...s.params, headed: true } } : s,
    );
}

function initialPosition(): { x: number; y: number } {
    if (typeof window === 'undefined') return { x: 80, y: 80 };
    return {
        x: Math.max(16, window.innerWidth - PANEL_WIDTH - 32),
        y: 80,
    };
}

export function WorkflowReplayDialog({ slug, name, onClose }: Props) {
    const styles = useStyles();

    // --- position / drag ---
    const [pos, setPos] = useState(initialPosition);
    const [minimized, setMinimized] = useState(false);
    const dragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0 });
    const [dragging, setDragging] = useState(false);

    const onTitleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y };
        setDragging(true);
    }, [pos]);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            const d = dragRef.current;
            if (!d.active) return;
            const nx = Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, d.originX + (e.clientX - d.startX)));
            const ny = Math.max(0, Math.min(window.innerHeight - PANEL_MIN_HEIGHT, d.originY + (e.clientY - d.startY)));
            setPos({ x: nx, y: ny });
        };
        const onUp = () => {
            if (dragRef.current.active) {
                dragRef.current.active = false;
                setDragging(false);
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
    }, []);

    // --- workflow state ---
    const [workflow, setWorkflow] = useState<WorkflowFile | null>(null);
    const [params, setParams] = useState<Record<string, string>>({});
    const [boundSteps, setBoundSteps] = useState<WorkflowStep[]>([]);
    const [stepStates, setStepStates] = useState<StepRuntimeState[]>([]);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [latestScreenshot, setLatestScreenshot] = useState<string | undefined>();
    const [latestUrl, setLatestUrl] = useState<string | undefined>();

    const [pendingApproval, setPendingApproval] = useState<{
        stepIndex: number; risk: BrowserRisk; intent: string; resolve: (ok: boolean) => void;
    } | null>(null);

    const humanResumeRef = useRef<((skip: boolean) => void) | null>(null);
    const [humanMode, setHumanMode] = useState<'paused' | 'error-recovery' | null>(null);
    const [humanMessage, setHumanMessage] = useState('');

    useEffect(() => {
        invoke<WorkflowFile>('workflow_load', { slug })
            .then(setWorkflow)
            .catch((e) => setError(String(e)));
    }, [slug]);

    useEffect(() => () => { window.dispatchEvent(new CustomEvent('workflow-replay-stopped')); }, []);

    const doneCount = stepStates.filter((s) => s.status === 'done').length;
    const totalCount = boundSteps.length || (workflow?.steps.length ?? 0);

    const allParamsFilled = useMemo(() => {
        if (!workflow) return false;
        return workflow.parameters.filter((p) => p.required).every((p) => (params[p.name] ?? '').trim().length > 0);
    }, [workflow, params]);

    const waitForHuman = useCallback((message: string, mode: 'paused' | 'error-recovery'): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            humanResumeRef.current = resolve;
            setHumanMessage(message);
            setHumanMode(mode);
        });
    }, []);

    const handleResume = useCallback((skip: boolean) => {
        const resolve = humanResumeRef.current;
        humanResumeRef.current = null;
        setHumanMode(null);
        setHumanMessage('');
        resolve?.(skip);
    }, []);

    const runStep = useCallback(
        async (step: WorkflowStep, idx: number): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
            const toolName = methodToToolName(step.tool);
            const risk = classifyBrowserAction({ method: toolName, params: step.params, hints: { tags: step.params.tags as string[] | undefined } });
            if (risk === 'write' || risk === 'destructive') {
                setStepStates((prev) => { const n = [...prev]; n[idx] = { status: 'awaiting_approval' }; return n; });
                const approved = await new Promise<boolean>((resolve) => {
                    setPendingApproval({ stepIndex: idx, risk, intent: describeBrowserAction({ method: toolName, params: step.params }, step.observedUrl ?? latestUrl), resolve });
                });
                setPendingApproval(null);
                if (!approved) return { ok: false, error: 'Denied by user' };
            }
            setStepStates((prev) => { const n = [...prev]; n[idx] = { status: 'running' }; return n; });
            try {
                const result = await invoke<Record<string, unknown>>('browser_rpc', { request: { method: step.tool, params: step.params } });
                if (step.tool === 'browser.observe') {
                    const ss = (result as { screenshot?: string }).screenshot;
                    if (ss) setLatestScreenshot(ss);
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
            const bound = applyReplayOverrides(raw);
            setBoundSteps(bound);
            setStepStates(bound.map(() => ({ status: 'pending' })));

            for (let i = 0; i < bound.length; i++) {
                const r = await runStep(bound[i], i);
                if (r.ok) {
                    setStepStates((prev) => { const n = [...prev]; n[i] = { status: 'done', result: r.result as Record<string, unknown> }; return n; });
                    if (i < bound.length - 1) await humanDelay(bound[i].tool, bound[i].params);
                } else if (r.error === 'Denied by user') {
                    setStepStates((prev) => { const n = [...prev]; n[i] = { status: 'denied', error: r.error }; return n; });
                    break;
                } else {
                    setStepStates((prev) => { const n = [...prev]; n[i] = { status: 'error', error: r.error }; return n; });
                    const shouldSkip = await waitForHuman(
                        `Step ${i + 1} failed: ${r.error ?? 'unknown error'}. Fix it in the browser, then click "Resume from next step" — or click "Stop" to abort.`,
                        'error-recovery',
                    );
                    if (!shouldSkip) break;
                    setStepStates((prev) => { const n = [...prev]; n[i] = { status: 'skipped', error: r.error }; return n; });
                }
            }
        } catch (e) {
            setError(String(e));
        } finally {
            setRunning(false);
            window.dispatchEvent(new CustomEvent('workflow-replay-stopped'));
        }
    }, [workflow, params, slug, runStep, waitForHuman]);

    const panel = (
        <div
            className={styles.panel}
            style={{ left: pos.x, top: pos.y }}
        >
            {/* ── Title bar / drag handle ── */}
            <div
                className={`${styles.titleBar}${dragging ? ` ${styles.titleBarDragging}` : ''}`}
                onMouseDown={onTitleMouseDown}
            >
                <Text weight="semibold" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Replay: {name}
                </Text>
                {running && !minimized && <Spinner size="extra-tiny" />}
                {minimized && totalCount > 0 && (
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>
                        {doneCount}/{totalCount}
                    </Text>
                )}
                {minimized && humanMode && (
                    <Text size={200} style={{ color: tokens.colorPaletteBlueForeground2, flexShrink: 0 }}>
                        Waiting for you
                    </Text>
                )}
                <Button
                    appearance="subtle"
                    size="small"
                    icon={minimized ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
                    title={minimized ? 'Restore' : 'Minimize'}
                    onClick={() => setMinimized((m) => !m)}
                />
                <Button
                    appearance="subtle"
                    size="small"
                    icon={<Dismiss16Regular />}
                    title="Close"
                    onClick={onClose}
                />
            </div>

            {/* ── Body (hidden when minimized) ── */}
            {!minimized && (
                <div className={styles.body}>
                    {!workflow && !error && <Spinner size="small" label="Loading…" />}
                    {error && <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}

                    {workflow && (
                        <>
                            {/* Parameters */}
                            {workflow.parameters.length > 0 && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <Text weight="semibold">Parameters</Text>
                                    {workflow.parameters.map((p) => (
                                        <div key={p.name} className={styles.paramRow}>
                                            <Text size={200}>{p.name}{p.required ? ' *' : ''}</Text>
                                            <Input
                                                value={params[p.name] ?? ''}
                                                onChange={(_, d) => setParams((prev) => ({ ...prev, [p.name]: d.value }))}
                                            />
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Step list header */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <Text weight="semibold">Steps ({workflow.steps.length})</Text>
                                {running && !humanMode && (
                                    <Button size="small" appearance="subtle" icon={<Person16Regular />} onClick={() => waitForHuman('Browser handed to you. Complete any login, CAPTCHA, or 2FA, then click Resume.', 'paused')}>
                                        Take over
                                    </Button>
                                )}
                            </div>

                            {/* Step list */}
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
                                                    <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{state.error}</Text>
                                                )}
                                                {state.status === 'skipped' && (
                                                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Skipped (fixed manually)</Text>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Human takeover / error recovery */}
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

                            {/* Write/destructive approval */}
                            {pendingApproval && (
                                <div className={styles.actionCard}>
                                    <Text weight="semibold">Confirm step {pendingApproval.stepIndex + 1} — {pendingApproval.risk}</Text>
                                    <Text size={200} style={{ display: 'block', marginTop: 4 }}>{pendingApproval.intent}</Text>
                                    {latestScreenshot && (
                                        <img
                                            src={`data:image/jpeg;base64,${latestScreenshot}`}
                                            alt="latest observation"
                                            style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain', marginTop: 8, borderRadius: 4, background: tokens.colorNeutralBackground1 }}
                                        />
                                    )}
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                                        <Button size="small" onClick={() => pendingApproval.resolve(false)}>Deny</Button>
                                        <Button
                                            size="small"
                                            appearance="primary"
                                            style={pendingApproval.risk === 'destructive' ? { backgroundColor: '#d13438', color: 'white' } as React.CSSProperties : undefined}
                                            onClick={() => pendingApproval.resolve(true)}
                                        >
                                            {pendingApproval.risk === 'destructive' ? 'Proceed Anyway' : 'Approve'}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* Footer actions */}
                            <div className={styles.footer}>
                                <Button appearance="secondary" size="small" onClick={onClose}>Close</Button>
                                <Button
                                    appearance="primary"
                                    size="small"
                                    disabled={!workflow || running || !allParamsFilled}
                                    onClick={run}
                                >
                                    {running ? 'Replaying…' : boundSteps.length ? 'Re-run' : 'Run'}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );

    return createPortal(panel, document.body);
}

export default WorkflowReplayDialog;
