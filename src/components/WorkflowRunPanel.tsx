'use client';

// WorkflowRunPanel — production-grade workflow execution UI.
//
// Replaces the old WorkflowReplayDialog. Drives the WorkflowEngine and surfaces:
//   - Intent-readable step list with actor badges (🤖 auto / 🧠 agent / 👤 human)
//   - Live variable panel showing resolved values
//   - Per-step retry counter and agent reasoning (expandable)
//   - HumanInputGate for actor=human steps
//   - HumanInterventionGate for failed steps needing manual fix
//   - Write/destructive approval card with screenshot
//   - Global Abort button always visible
//   - Durable resume: accepts an existing WorkflowRun to continue from
//
// Floats fixed on screen, draggable by title bar, collapsible.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { makeStyles, tokens, Text, Button, Input, Spinner, FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components';
import { useTheme } from '@/lib/ThemeContext';
import {
    ChevronDown16Regular,
    ChevronUp16Regular,
    Dismiss16Regular,
    Stop16Regular,
    Person16Regular,
} from '@fluentui/react-icons';
import { WorkflowEngine } from '@/lib/workflows/engine';
import type { EngineCallbacks } from '@/lib/workflows/engine';
import { StepRow } from './workflow/StepRow';
import { VariablesPanel } from './workflow/VariablesPanel';
import { HumanInputGate, HumanInterventionGate, StepRepairGate, FixProposalGate } from './workflow/HumanGate';
import { classifyBrowserAction } from '@/lib/ai/browser-classify';
import type {
    WorkflowFile,
    WorkflowFileV2,
    WorkflowStepV2,
    WorkflowRun,
    StepRunStatus,
    ActorKind,
    HumanInput,
    TraceEvent,
    RecoveryAction,
} from '@/types/workflow-types';
import { isV2 } from '@/types/workflow-types';
import type { ModelConfig } from '@/types/ai-types';
import type { BrowserRisk } from '@/lib/ai/browser-classify';

const PANEL_WIDTH = 560;
const PANEL_MIN_HEIGHT = 46;

interface StepUiState {
    status: StepRunStatus;
    attemptCount: number;
    agentReasoning?: string;
    errorMessage?: string;
    screenshot?: string;
    agentModel?: string;
    agentUsage?: import('@/types/workflow-types').AgentUsage;
}

interface PendingApproval {
    stepIndex: number;
    risk: BrowserRisk;
    intent: string;
    screenshot?: string;
    resolve(approved: boolean): void;
}

interface PendingHumanInput {
    step: WorkflowStepV2;
    prompt: string;
    inputs: HumanInput[];
    resolve(values: Record<string, unknown>): void;
    reject(): void;
}

interface PendingIntervention {
    stepIndex: number;
    message: string;
    agentReasoning?: string;
    screenshot?: string;
    resolve(decision: 'resume' | 'skip' | 'abort'): void;
}

interface PendingRepair {
    stepIndex: number;
    step: WorkflowStepV2;
    lastError: string;
    screenshot?: string;
    resolve(repaired: WorkflowStepV2 | null): void;
}

interface FixProposal {
    stepIndex: number;
    actions: RecoveryAction[];
}

interface VariableEntry {
    name: string;
    value: unknown;
}

interface Props {
    slug: string;
    name: string;
    existingRun?: WorkflowRun;
    /** Pre-filled variable values (e.g. when launched from the run_workflow agent tool). */
    initialVariables?: Record<string, unknown>;
    modelConfig?: ModelConfig | null;
    onClose(): void;
}

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
    body: {
        overflowY: 'auto',
        maxHeight: 'calc(85vh - 46px)',
        display: 'flex',
        flexDirection: 'column',
    },
    paramSection: {
        padding: '10px 14px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
    },
    stepList: {
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '6px',
        overflow: 'hidden',
        margin: '0 12px',
    },
    cardSection: {
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    approvalCard: {
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    footer: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
        background: tokens.colorNeutralBackground2,
    },
});

function initialPos(): { x: number; y: number } {
    if (typeof window === 'undefined') return { x: 80, y: 80 };
    return { x: Math.round((window.innerWidth - PANEL_WIDTH) / 2), y: Math.round(window.innerHeight * 0.35) };
}

export function WorkflowRunPanel({ slug, name, existingRun, initialVariables, modelConfig, onClose }: Props) {
    const styles = useStyles();
    const engineRef = useRef<WorkflowEngine | null>(null);
    const { theme: appTheme } = useTheme();
    const fluentTheme = appTheme === 'light' ? webLightTheme : webDarkTheme;

    // Drag
    const [pos, setPos] = useState(initialPos);
    const [minimized, setMinimized] = useState(false);
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef({ active: false, startX: 0, startY: 0, ox: 0, oy: 0 });
    const [hovered, setHovered] = useState(false);

    const onTitleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, ox: pos.x, oy: pos.y };
        setDragging(true);
    }, [pos]);

    useEffect(() => {
        const move = (e: MouseEvent) => {
            const d = dragRef.current;
            if (!d.active) return;
            setPos({
                x: Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, d.ox + (e.clientX - d.startX))),
                y: Math.max(0, Math.min(window.innerHeight - PANEL_MIN_HEIGHT, d.oy + (e.clientY - d.startY))),
            });
        };
        const up = () => { dragRef.current.active = false; setDragging(false); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    }, []);

    // Workflow state
    const [workflow, setWorkflow] = useState<WorkflowFile | null>(null);
    const [paramValues, setParamValues] = useState<Record<string, string>>({});
    const [stepStates, setStepStates] = useState<StepUiState[]>([]);
    const [variables, setVariables] = useState<VariableEntry[]>([]);
    const [running, setRunning] = useState(false);
    const [runStatus, setRunStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [stepLogs, setStepLogs] = useState<Record<number, string[]>>({});
    const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
    const [traceExpanded, setTraceExpanded] = useState(false);
    const [pendingRepair, setPendingRepair] = useState<PendingRepair | null>(null);
    const [fixProposal, setFixProposal] = useState<FixProposal | null>(null);

    // Human interaction queues
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingHumanInput, setPendingHumanInput] = useState<PendingHumanInput | null>(null);
    const [pendingIntervention, setPendingIntervention] = useState<PendingIntervention | null>(null);

    // Build EngineCallbacks
    const buildCallbacks = useCallback((): EngineCallbacks => ({
        onStepStatus(idx, status, attempt) {
            setStepStates((prev) => {
                const next = [...prev];
                const current = next[idx] ?? { status: 'pending', attemptCount: 0 };
                next[idx] = {
                    ...current,
                    status,
                    attemptCount: attempt?.n ?? current.attemptCount,
                    agentReasoning: attempt?.agentReasoning ?? current.agentReasoning,
                    errorMessage: attempt?.error ?? (status !== 'done' ? current.errorMessage : undefined),
                    screenshot: attempt?.screenshotB64 ?? current.screenshot,
                    agentModel: attempt?.agentModel ?? current.agentModel,
                    agentUsage: attempt?.agentUsage ?? current.agentUsage,
                };
                return next;
            });
        },
        onVariableResolved(varName, value) {
            setVariables((prev) =>
                prev.map((v) => v.name === varName ? { ...v, value } : v),
            );
        },
        onHumanInputRequired(step, prompt, inputs) {
            return new Promise((resolve, reject) => {
                setPendingHumanInput({ step, prompt, inputs, resolve, reject });
            });
        },
        onHumanInterventionRequired(stepIndex, message, agentReasoning, screenshot) {
            return new Promise((resolve) => {
                setPendingIntervention({ stepIndex, message, agentReasoning, screenshot, resolve });
            });
        },
        onApprovalRequired(stepIndex, risk, intent, screenshot) {
            return new Promise((resolve) => {
                setPendingApproval({ stepIndex, risk, intent, screenshot, resolve });
            });
        },
        onAgentRecoveryProgress(stepIndex, msg) {
            setStepLogs((prev) => ({
                ...prev,
                [stepIndex]: [...(prev[stepIndex] ?? []), msg],
            }));
        },
        onTraceEvent(event) {
            setTraceEvents((prev) => [...prev, event]);
        },
        onStepRepairRequested(stepIndex, step, lastError, screenshot) {
            return new Promise((resolve) => {
                setPendingRepair({ stepIndex, step, lastError, screenshot, resolve });
            });
        },
        onFixAvailable(stepIndex, actions) {
            // Only propose if actions aren't already in the workflow (avoid duplicates on resume)
            setFixProposal((prev) => prev ?? { stepIndex, actions });
        },
    }), []);

    // Load workflow
    useEffect(() => {
        invoke<WorkflowFile>('workflow_load', { slug })
            .then((wf) => {
                setWorkflow(wf);
                const steps = isV2(wf) ? wf.steps : (wf as any).steps ?? [];
                setStepStates(steps.map(() => ({ status: 'pending' as StepRunStatus, attemptCount: 0 })));
                if (isV2(wf)) {
                    setVariables(wf.variables.map((v) => ({ name: v.name, value: undefined })));
                    // Pre-fill param values from initialVariables (agent-provided)
                    if (initialVariables && Object.keys(initialVariables).length > 0) {
                        const seeded: Record<string, string> = {};
                        for (const v of wf.variables) {
                            const val = initialVariables[v.name];
                            if (val !== undefined) seeded[v.name] = String(val);
                        }
                        if (Object.keys(seeded).length > 0) {
                            setParamValues((prev) => ({ ...prev, ...seeded }));
                        }
                    }
                }
            })
            .catch((e) => setError(String(e)));
    }, [slug, initialVariables]);

    useEffect(() => () => {
        engineRef.current?.abort();
        window.dispatchEvent(new CustomEvent('workflow-replay-stopped'));
    }, []);

    const run = useCallback(async () => {
        if (!workflow) return;
        setRunning(true);
        setError(null);
        setRunStatus(null);
        setStepLogs({});
        window.dispatchEvent(new CustomEvent('workflow-replay-started'));

        // Clear any stale gate data in DB before starting
        if (existingRun) {
            try {
                await invoke('workflow_run_resolve_gate', { runId: existingRun.runId });
            } catch (e) {
                console.warn('[RunPanel] clear stale gate failed:', e);
            }
        }

        const engine = new WorkflowEngine();
        engineRef.current = engine;

        const inputVars: Record<string, unknown> = { ...paramValues };

        try {
            const result = existingRun
                ? await engine.resume(existingRun, modelConfig ?? null, buildCallbacks())
                : await engine.run(slug, inputVars, modelConfig ?? null, buildCallbacks());
            setRunStatus(result.status);
        } catch (e) {
            setError(String(e));
        } finally {
            setRunning(false);
            window.dispatchEvent(new CustomEvent('workflow-replay-stopped'));
        }
    }, [workflow, paramValues, modelConfig, slug, existingRun, buildCallbacks]);

    const abort = useCallback(() => {
        engineRef.current?.abort();
        pendingApproval?.resolve(false);
        setPendingApproval(null);
        pendingIntervention?.resolve('abort');
        setPendingIntervention(null);
        pendingHumanInput?.reject();
        setPendingHumanInput(null);
        pendingRepair?.resolve(null);
        setPendingRepair(null);
        setFixProposal(null);
    }, [pendingApproval, pendingIntervention, pendingHumanInput, pendingRepair, fixProposal]);

    const handleSaveFix = useCallback(async () => {
        if (!fixProposal || !slug) return;
        try {
            const wf = await invoke<WorkflowFile>('workflow_load', { slug });
            if (!isV2(wf)) return;
            const newSteps = fixProposal.actions.map((a, i) => ({
                id: `fix-step-${fixProposal.stepIndex}-${i}`,
                intent: a.tool === 'browser_open' ? 'Open browser session' : `Execute ${a.tool}`,
                tool: a.tool === 'browser_open' ? 'browser.open'
                    : a.tool === 'browser_navigate' ? 'browser.navigate'
                    : a.tool === 'browser_act' ? 'browser.act'
                    : a.tool === 'browser_close' ? 'browser.close'
                    : a.tool,
                params: a.params as Record<string, unknown>,
                actor: 'auto' as ActorKind,
                classification: 'read',
                retry: { maxAuto: 2, escalateTo: 'agent' as const },
            }));
            const updated: WorkflowFileV2 = {
                ...wf,
                steps: [
                    ...wf.steps.slice(0, fixProposal.stepIndex),
                    ...newSteps,
                    ...wf.steps.slice(fixProposal.stepIndex),
                ],
            };
            await invoke('workflow_update', { definition: updated });
            setFixProposal(null);
        } catch (e) {
            console.warn('[run-panel] save fix failed:', e);
        }
    }, [fixProposal, slug]);

    const v2 = workflow && isV2(workflow) ? workflow as WorkflowFileV2 : null;
    const rawSteps: any[] = workflow ? ((isV2(workflow) ? workflow.steps : (workflow as any).steps) ?? []) : [];
    const totalSteps = workflow ? (isV2(workflow) ? workflow.steps.length : (workflow as any).steps?.length ?? 0) : 0;
    const doneCount = stepStates.filter((s) => s.status === 'done').length;
    const v2Vars = v2?.variables ?? [];
    const missingRequired = v2Vars.filter(
        (vr) => vr.source === 'human_input' && !vr.defaultValue && !(paramValues[vr.name] ?? '').trim(),
    );
    const hasRequiredParams = missingRequired.length === 0;

    const panel = (
        <div
            className={styles.panel}
            style={{ left: pos.x, top: pos.y, opacity: hovered ? 1 : 0.9, transition: 'opacity 0.18s ease' }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {/* Title bar */}
            <div
                className={styles.titleBar}
                style={{ cursor: dragging ? 'grabbing' : 'grab' }}
                onMouseDown={onTitleMouseDown}
            >
                <Text weight="semibold" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                    {running ? '↺' : runStatus === 'completed' ? '✓' : '⏵'} {name}
                </Text>
                {running && <Spinner size="extra-tiny" style={{ flexShrink: 0 }} />}
                {totalSteps > 0 && (
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>
                        {doneCount}/{totalSteps}
                    </Text>
                )}
                <Button
                    appearance="primary"
                    size="small"
                    disabled={!workflow || running || !hasRequiredParams}
                    title={!hasRequiredParams ? `Fill in required fields: ${missingRequired.map((v) => v.description || v.name).join(', ')}` : undefined}
                    onClick={run}
                >
                    {running ? 'Running…' : existingRun ? 'Resume' : 'Run'}
                </Button>
                <Button appearance="subtle" size="small" icon={minimized ? <ChevronUp16Regular /> : <ChevronDown16Regular />} onClick={() => setMinimized((m) => !m)} />
                <Button appearance="subtle" size="small" icon={<Dismiss16Regular />} onClick={onClose} />
            </div>

            {!minimized && (
                <div className={styles.body}>
                    {!workflow && !error && (
                        <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
                            <Spinner size="small" label="Loading…" />
                        </div>
                    )}
                    {error && (
                        <div style={{ padding: '10px 14px' }}>
                            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>
                        </div>
                    )}

                    {workflow && (
                        <>
                            {/* Variables panel */}
                            <VariablesPanel variables={variables} />

                            {/* human_input params (required before run) */}
                            {v2 && v2Vars.some((v) => v.source === 'human_input') && !running && (
                                <div className={styles.paramSection}>
                                    <Text weight="semibold" size={200}>
                                        Parameters
                                        {missingRequired.length > 0 && (
                                            <span style={{ color: tokens.colorPaletteRedForeground1, marginLeft: 6, fontWeight: 'normal', fontSize: 11 }}>
                                                — fill in required fields (*) to enable Run
                                            </span>
                                        )}
                                    </Text>
                                    {v2Vars.filter((v) => v.source === 'human_input').map((vr) => {
                                        const required = !vr.defaultValue;
                                        const missing = required && !(paramValues[vr.name] ?? '').trim();
                                        return (
                                            <div key={vr.name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                                <Text size={100} style={missing ? { color: tokens.colorPaletteRedForeground1 } : undefined}>
                                                    {vr.description || vr.name}{required ? ' *' : ''}
                                                </Text>
                                                <Input
                                                    type={vr.sensitive ? 'password' : 'text'}
                                                    value={paramValues[vr.name] ?? ''}
                                                    onChange={(_, d) => setParamValues((p) => ({ ...p, [vr.name]: d.value }))}
                                                    placeholder={vr.defaultValue ?? ''}
                                                    style={missing ? { borderColor: tokens.colorPaletteRedBorder2 } as React.CSSProperties : undefined}
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Description / goal */}
                            {v2?.description && !running && (
                                <div style={{ padding: '6px 14px 0' }}>
                                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>{v2.description}</Text>
                                </div>
                            )}

                            {/* Step list */}
                            <div style={{ padding: '10px 12px' }}>
                                <Text weight="semibold" size={200} style={{ paddingBottom: 6, display: 'block' }}>
                                    Steps ({rawSteps.length})
                                </Text>
                                <div className={styles.stepList}>
                                    {rawSteps.map((step: any, i: number) => {
                                        const state = stepStates[i] ?? { status: 'pending', attemptCount: 0 };
                                        const logs: string[] = [
                                            ...(stepLogs[i] ?? []),
                                            ...(state.agentReasoning ? [state.agentReasoning] : []),
                                        ];
                                        return (
                                            <StepRow
                                                key={step.id ?? i}
                                                index={i}
                                                intent={step.intent || step.tool}
                                                tool={step.tool}
                                                actor={(step.actor ?? 'auto') as ActorKind}
                                                classification={step.classification ?? 'read'}
                                                status={state.status}
                                                attemptCount={state.attemptCount}
                                                maxAuto={step.retry?.maxAuto ?? 2}
                                                agentLogs={logs.length > 0 ? logs : undefined}
                                                errorMessage={state.errorMessage}
                                                screenshot={state.screenshot}
                                                observedUrl={step.observedUrl}
                                                agentModel={state.agentModel}
                                                agentUsage={state.agentUsage}
                                            />
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Trace timeline */}
                            {traceEvents.length > 0 && (
                                <div className={styles.cardSection} style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, padding: '8px 14px' }}>
                                    <button
                                        onClick={() => setTraceExpanded(e => !e)}
                                        style={{
                                            background: 'none', border: 'none', cursor: 'pointer',
                                            color: tokens.colorNeutralForeground2, fontSize: '11px',
                                            display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                                            padding: 0, fontFamily: 'inherit',
                                        }}
                                    >
                                        {traceExpanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
                                        Trace log ({traceEvents.length} events)
                                    </button>
                                    {traceExpanded && (
                                        <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', fontSize: '10px', fontFamily: 'monospace' }}>
                                            {traceEvents.map((ev, i) => (
                                                <div key={i} style={{ display: 'flex', gap: 8, padding: '2px 0', color: tokens.colorNeutralForeground3 }}>
                                                    <span style={{ color: tokens.colorNeutralForeground4, whiteSpace: 'nowrap' }}>
                                                        {ev.createdAt.split('T')[1]?.split('.')[0]}
                                                    </span>
                                                    <span style={{
                                                        color: ev.eventType.startsWith('run_') ? tokens.colorPaletteBlueForeground2
                                                            : ev.eventType.startsWith('step_ok') || ev.eventType.startsWith('recovery_ok') ? tokens.colorPaletteGreenForeground1
                                                            : ev.eventType.startsWith('step_fail') || ev.eventType.startsWith('recovery_fail') ? tokens.colorPaletteRedForeground1
                                                            : ev.eventType.startsWith('gate_') ? tokens.colorPaletteDarkOrangeForeground1
                                                            : tokens.colorNeutralForeground2,
                                                        fontWeight: ev.eventType === 'step_start' ? 600 : 400,
                                                    }}>
                                                        {ev.eventType}
                                                    </span>
                                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {ev.stepIndex !== null ? `step ${ev.stepIndex}` : ''}
                                                        {ev.eventData && typeof ev.eventData === 'object' && 'tool' in ev.eventData ? ` ${ev.eventData.tool}` : ''}
                                                        {ev.eventData && typeof ev.eventData === 'object' && 'error' in ev.eventData ? `: ${String(ev.eventData.error).slice(0, 80)}` : ''}
                                                        {ev.eventData && typeof ev.eventData === 'object' && 'actor' in ev.eventData ? ` ${ev.eventData.actor}` : ''}
                                                        {ev.eventData && typeof ev.eventData === 'object' && 'gateType' in ev.eventData ? ` ${ev.eventData.gateType}` : ''}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Fix proposal (agent recovery found missing steps) */}
                            {fixProposal && (
                                <div className={styles.cardSection}>
                                    <FixProposalGate
                                        stepIndex={fixProposal.stepIndex}
                                        actions={fixProposal.actions}
                                        onSave={handleSaveFix}
                                        onDismiss={() => setFixProposal(null)}
                                    />
                                </div>
                            )}

                            {/* Run status */}
                            {runStatus && (
                                <div style={{ padding: '6px 14px 10px' }}>
                                    <Text size={200} style={{
                                        color: runStatus === 'completed' ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1
                                    }}>
                                        {runStatus === 'completed' ? '✓ Workflow completed successfully.' : `✗ Workflow ${runStatus}.`}
                                    </Text>
                                </div>
                            )}

                            {/* Human input gate */}
                            {pendingHumanInput && (
                                <div className={styles.cardSection}>
                                    <HumanInputGate
                                        prompt={pendingHumanInput.prompt}
                                        inputs={pendingHumanInput.inputs}
                                        onSubmit={(vals) => {
                                            const h = pendingHumanInput;
                                            setPendingHumanInput(null);
                                            h.resolve(vals);
                                        }}
                                        onSkip={() => {
                                            pendingHumanInput.reject();
                                            setPendingHumanInput(null);
                                        }}
                                    />
                                </div>
                            )}

                            {/* Step repair gate */}
                            {pendingRepair && (
                                <div className={styles.cardSection}>
                                    <StepRepairGate
                                        step={pendingRepair.step}
                                        lastError={pendingRepair.lastError}
                                        screenshot={pendingRepair.screenshot}
                                        onApply={(patched) => {
                                            pendingRepair.resolve(patched);
                                            setPendingRepair(null);
                                        }}
                                        onSkip={() => {
                                            pendingRepair.resolve(null);
                                            setPendingRepair(null);
                                        }}
                                    />
                                </div>
                            )}

                            {/* Write/destructive approval */}
                            {pendingApproval && (
                                <div className={styles.cardSection}>
                                    <div className={styles.approvalCard}>
                                        <Text weight="semibold">
                                            Approve step {pendingApproval.stepIndex + 1} — {pendingApproval.risk}
                                        </Text>
                                        <Text size={200}>{pendingApproval.intent}</Text>
                                        {pendingApproval.screenshot && (
                                            <img
                                                src={`data:image/jpeg;base64,${pendingApproval.screenshot}`}
                                                alt="current state"
                                                style={{ width: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 4, background: tokens.colorNeutralBackground1 }}
                                            />
                                        )}
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                            <Button size="small" onClick={() => { pendingApproval.resolve(false); setPendingApproval(null); }}>Deny</Button>
                                            <Button
                                                size="small"
                                                appearance="primary"
                                                style={pendingApproval.risk === 'destructive' ? { backgroundColor: '#d13438', color: 'white' } as React.CSSProperties : undefined}
                                                onClick={() => { pendingApproval.resolve(true); setPendingApproval(null); }}
                                            >
                                                {pendingApproval.risk === 'destructive' ? 'Proceed Anyway' : 'Approve'}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Human intervention gate */}
                            {pendingIntervention && (
                                <div className={styles.cardSection}>
                                    <HumanInterventionGate
                                        message={pendingIntervention.message}
                                        agentReasoning={pendingIntervention.agentReasoning}
                                        screenshot={pendingIntervention.screenshot}
                                        onResume={() => { pendingIntervention.resolve('resume'); setPendingIntervention(null); }}
                                        onSkip={() => { pendingIntervention.resolve('skip'); setPendingIntervention(null); }}
                                        onAbort={() => { pendingIntervention.resolve('abort'); setPendingIntervention(null); abort(); }}
                                    />
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* Footer: Take over + Abort — always visible when running */}
            {running && (
                <div className={styles.footer}>
                    <Button
                        size="small"
                        appearance="subtle"
                        icon={<Person16Regular />}
                        onClick={() => {
                            // Surface human intervention gate on demand
                            if (!pendingIntervention) {
                                const promise = new Promise<'resume' | 'skip' | 'abort'>((resolve) => {
                                    setPendingIntervention({
                                        stepIndex: doneCount,
                                        message: 'Browser handed to you. Complete any login, CAPTCHA, or 2FA, then click Resume.',
                                        resolve,
                                    });
                                });
                                promise.then(() => {}); // consumed by the gate
                            }
                        }}
                    >
                        Take over
                    </Button>
                    <div style={{ flex: 1 }} />
                    <Button size="small" icon={<Stop16Regular />} onClick={abort}>
                        Abort workflow
                    </Button>
                </div>
            )}
        </div>
    );

    return createPortal(
        <FluentProvider theme={fluentTheme}>{panel}</FluentProvider>,
        document.body,
    );
}

export default WorkflowRunPanel;
