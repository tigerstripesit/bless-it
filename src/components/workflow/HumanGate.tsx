'use client';

// HumanGate — two flavours of human pause card:
//
//  HumanInputGate   — step.actor='human', needs form input before it can run
//  HumanInterventionGate — step failed all retries, user must fix in browser

import React, { useState } from 'react';
import { makeStyles, tokens, Text, Button, Input, Select, Textarea } from '@fluentui/react-components';
import { Person20Regular, ErrorCircle20Regular, Sparkle16Regular, Edit16Regular } from '@fluentui/react-icons';
import type { HumanInput, WorkflowStepV2, ActorKind, RecoveryAction } from '@/types/workflow-types';

// ── HumanInputGate ─────────────────────────────────────────────────────────

interface HumanInputGateProps {
    prompt: string;
    inputs: HumanInput[];
    screenshot?: string;
    onSubmit(values: Record<string, unknown>): void;
    onSkip(): void;
}

const useInputStyles = makeStyles({
    card: {
        border: `1.5px solid ${tokens.colorPaletteBlueBorderActive}`,
        borderRadius: '8px',
        padding: '12px',
        background: '#eef5ff',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
    },
    fields: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    field: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
    },
    actions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
        marginTop: '2px',
    },
    screenshot: {
        width: '100%',
        maxHeight: '160px',
        objectFit: 'contain',
        borderRadius: '4px',
        background: tokens.colorNeutralBackground1,
    },
});

export function HumanInputGate({ prompt, inputs, screenshot, onSubmit, onSkip }: HumanInputGateProps) {
    const styles = useInputStyles();
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(inputs.map((i) => [i.name, ''])),
    );

    const allRequired = inputs.filter((i) => i.required).every((i) => (values[i.name] ?? '').trim().length > 0);

    return (
        <div className={styles.card}>
            <div className={styles.header}>
                <Person20Regular style={{ flexShrink: 0, color: tokens.colorPaletteBlueForeground2, marginTop: 1 }} />
                <Text size={200}>{prompt}</Text>
            </div>

            {screenshot && (
                <img src={`data:image/jpeg;base64,${screenshot}`} alt="current state" className={styles.screenshot} />
            )}

            <div className={styles.fields}>
                {inputs.map((input) => (
                    <div key={input.name} className={styles.field}>
                        <Text size={100} weight="semibold" style={{ color: tokens.colorNeutralForeground2 }}>
                            {input.label}{input.required ? ' *' : ''}
                        </Text>
                        {input.type === 'select' ? (
                            <Select
                                value={values[input.name] ?? ''}
                                onChange={(_, d) => setValues((prev) => ({ ...prev, [input.name]: d.value }))}
                            >
                                <option value="">— select —</option>
                                {(input.options ?? []).map((opt) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </Select>
                        ) : (
                            <Input
                                type={input.type === 'password' ? 'password' : 'text'}
                                value={values[input.name] ?? ''}
                                onChange={(_, d) => setValues((prev) => ({ ...prev, [input.name]: d.value }))}
                            />
                        )}
                    </div>
                ))}
            </div>

            <div className={styles.actions}>
                <Button size="small" appearance="subtle" onClick={onSkip}>Skip step</Button>
                <Button
                    size="small"
                    appearance="primary"
                    disabled={!allRequired}
                    onClick={() => onSubmit(values)}
                >
                    Continue
                </Button>
            </div>
        </div>
    );
}

// ── HumanInterventionGate ──────────────────────────────────────────────────

interface HumanInterventionGateProps {
    message: string;
    agentReasoning?: string;
    screenshot?: string;
    onResume(): void;
    onSkip(): void;
    onAbort(): void;
}

const useInterventionStyles = makeStyles({
    card: {
        border: `1.5px solid ${tokens.colorPaletteRedBorder2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
    },
    reasoning: {
        background: tokens.colorNeutralBackground2,
        borderRadius: '4px',
        padding: '6px 8px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
    },
    actions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
    },
    screenshot: {
        width: '100%',
        maxHeight: '160px',
        objectFit: 'contain',
        borderRadius: '4px',
        background: tokens.colorNeutralBackground1,
    },
});

export function HumanInterventionGate({ message, agentReasoning, screenshot, onResume, onSkip, onAbort }: HumanInterventionGateProps) {
    const styles = useInterventionStyles();

    return (
        <div className={styles.card}>
            <div className={styles.header}>
                <ErrorCircle20Regular style={{ flexShrink: 0, color: tokens.colorPaletteRedForeground1, marginTop: 1 }} />
                <Text size={200}>{message}</Text>
            </div>

            {screenshot && (
                <img src={`data:image/jpeg;base64,${screenshot}`} alt="failure state" className={styles.screenshot} />
            )}

            {agentReasoning && (
                <div className={styles.reasoning}>
                    <Sparkle16Regular style={{ flexShrink: 0, color: tokens.colorPaletteBlueForeground2, marginTop: 1 }} />
                    <Text size={100} style={{ fontStyle: 'italic', color: tokens.colorNeutralForeground2 }}>
                        {agentReasoning}
                    </Text>
                </div>
            )}

            <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                Fix the issue in the browser above, then click <strong>Resume</strong>.
            </Text>

            <div className={styles.actions}>
                <Button size="small" onClick={onAbort}>Abort workflow</Button>
                <Button size="small" appearance="subtle" onClick={onSkip}>Skip step</Button>
                <Button size="small" appearance="primary" onClick={onResume}>Resume</Button>
            </div>
        </div>
    );
}

// ── StepRepairGate ───────────────────────────────────────────────────────────

interface StepRepairGateProps {
    step: WorkflowStepV2;
    lastError: string;
    screenshot?: string;
    onApply(patched: WorkflowStepV2): void;
    onSkip(): void;
}

const useRepairStyles = makeStyles({
    card: {
        border: `1.5px solid ${tokens.colorPaletteDarkOrangeBorder2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
    },
    screenshot: {
        width: '100%',
        maxHeight: '120px',
        objectFit: 'contain',
        borderRadius: '4px',
        background: tokens.colorNeutralBackground1,
    },
    field: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
    },
    actions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
    },
    actorBtn: {
        fontFamily: 'inherit',
        fontSize: '11px',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '4px',
        padding: '3px 8px',
    },
});

export function StepRepairGate({ step, lastError, screenshot, onApply, onSkip }: StepRepairGateProps) {
    const s = useRepairStyles();
    const [patched, setPatched] = useState<WorkflowStepV2>(() => ({
        ...step,
        params: { ...step.params },
    }));
    const [paramsJson, setParamsJson] = useState(() => JSON.stringify(step.params, null, 2));
    const [actor, setActor] = useState<ActorKind>(step.actor);
    const [maxAuto, setMaxAuto] = useState(step.retry?.maxAuto ?? 2);
    const [escalateTo, setEscalateTo] = useState(step.retry?.escalateTo ?? 'human');

    const apply = () => {
        let parsedParams = patched.params;
        try {
            parsedParams = JSON.parse(paramsJson);
        } catch { /* keep current */ }
        onApply({
            ...patched,
            actor,
            params: parsedParams,
            retry: { maxAuto, escalateTo, agentHint: step.retry?.agentHint },
        });
    };

    return (
        <div className={s.card}>
            <div className={s.header}>
                <Edit16Regular style={{ flexShrink: 0, color: tokens.colorPaletteDarkOrangeForeground1, marginTop: 1 }} />
                <Text size={200} weight="semibold">Repair step and retry</Text>
            </div>
            <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>
                {lastError}
            </Text>

            {screenshot && (
                <img src={`data:image/jpeg;base64,${screenshot}`} alt="failure state" className={s.screenshot} />
            )}

            <div className={s.field}>
                <Text size={100} style={{ color: tokens.colorNeutralForeground2 }}>Intent</Text>
                <Input
                    size="small"
                    value={patched.intent}
                    onChange={(_, d) => setPatched(p => ({ ...p, intent: d.value }))}
                />
            </div>

            <div className={s.field}>
                <Text size={100} style={{ color: tokens.colorNeutralForeground2 }}>Tool</Text>
                <Input
                    size="small"
                    value={patched.tool}
                    onChange={(_, d) => setPatched(p => ({ ...p, tool: d.value }))}
                />
            </div>

            <div className={s.field}>
                <Text size={100} style={{ color: tokens.colorNeutralForeground2 }}>Params (JSON)</Text>
                <Textarea
                    size="small"
                    value={paramsJson}
                    onChange={(_, d) => setParamsJson(d.value)}
                    style={{ fontFamily: 'monospace', fontSize: '11px', minHeight: 60 }}
                />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
                <div className={s.field} style={{ flex: 1 }}>
                    <Text size={100} style={{ color: tokens.colorNeutralForeground2 }}>Actor</Text>
                    <div style={{ display: 'flex', gap: 4 }}>
                        {(['auto', 'agent', 'human'] as ActorKind[]).map((a) => (
                            <button
                                key={a}
                                className={s.actorBtn}
                                style={{
                                    background: actor === a ? tokens.colorBrandBackground : tokens.colorNeutralBackground1,
                                    color: actor === a ? tokens.colorNeutralForegroundOnBrand : tokens.colorNeutralForeground1,
                                }}
                                onClick={() => setActor(a)}
                            >
                                {a}
                            </button>
                        ))}
                    </div>
                </div>
                <div className={s.field} style={{ flex: 1 }}>
                    <Text size={100} style={{ color: tokens.colorNeutralForeground2 }}>Max auto retries</Text>
                    <Input
                        size="small"
                        type="number"
                        value={String(maxAuto)}
                        onChange={(_, d) => setMaxAuto(Math.max(0, parseInt(d.value, 10) || 0))}
                    />
                </div>
                <div className={s.field} style={{ flex: 1 }}>
                    <Text size={100} style={{ color: tokens.colorNeutralForeground2 }}>Escalate to</Text>
                    <Select
                        size="small"
                        value={escalateTo}
                        onChange={(_, d) => setEscalateTo(d.value as 'agent' | 'human' | 'abort')}
                    >
                        <option value="agent">Agent</option>
                        <option value="human">Human</option>
                        <option value="abort">Abort</option>
                    </Select>
                </div>
            </div>

            <div className={s.actions}>
                <Button size="small" appearance="subtle" onClick={onSkip}>Skip repair</Button>
                <Button size="small" appearance="primary" onClick={apply}>Apply &amp; Retry</Button>
            </div>
        </div>
    );
}

// ── FixProposalGate ──────────────────────────────────────────────────────────

interface FixProposalGateProps {
    stepIndex: number;
    actions: RecoveryAction[];
    onSave(): void;
    onDismiss(): void;
}

const useFixStyles = makeStyles({
    card: {
        border: `1.5px solid ${tokens.colorPaletteGreenBorder2}`,
        borderRadius: '8px',
        padding: '12px',
        background: tokens.colorNeutralBackground2,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
    },
    actionRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 6px',
        borderRadius: '4px',
        background: tokens.colorNeutralBackground1,
        fontFamily: 'monospace',
        fontSize: '11px',
    },
    actions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '8px',
    },
});

export function FixProposalGate({ stepIndex, actions, onSave, onDismiss }: FixProposalGateProps) {
    const s = useFixStyles();
    return (
        <div className={s.card}>
            <div className={s.header}>
                <span style={{ color: tokens.colorPaletteGreenForeground1, fontSize: '14px' }}>✓</span>
                <Text size={200} weight="semibold">
                    Agent recovered step {stepIndex + 1}
                </Text>
            </div>
            <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                The agent called these tools to fix the issue. Save them as new workflow steps?
            </Text>
            {actions.map((a, i) => (
                <div key={i} className={s.actionRow}>
                    <span style={{ color: tokens.colorBrandForeground1, fontWeight: 600 }}>{a.tool}</span>
                    <span style={{ color: tokens.colorNeutralForeground4 }}>{JSON.stringify(a.params)}</span>
                </div>
            ))}
            <div className={s.actions}>
                <Button size="small" appearance="subtle" onClick={onDismiss}>Dismiss</Button>
                <Button size="small" appearance="primary" onClick={onSave}>Save to workflow</Button>
            </div>
        </div>
    );
}
