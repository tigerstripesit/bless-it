'use client';

// WorkflowRecordingReview — post-recording enrichment dialog.
//
// Opened immediately after "Stop & save". The raw captured steps are sent to
// the active LLM for enrichment (intent labelling, actor classification,
// variable suggestion). The user reviews the LLM's suggestions, edits
// anything that looks wrong, then clicks "Save workflow" to persist the
// final v2 file via workflow_recording_finalize.
//
// Graceful degradation: if the LLM call fails or no model is configured,
// the dialog still opens with blank intents that the user fills manually.

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    makeStyles,
    tokens,
    Text,
    Button,
    Input,
    Textarea,
    Spinner,
    Badge,
    Select,
} from '@fluentui/react-components';
import {
    Bot20Regular,
    Person20Regular,
    Sparkle20Regular,
    CheckmarkCircle20Regular,
    Edit20Regular,
    Warning20Regular,
} from '@fluentui/react-icons';
import { enrichRecording, applyHintsToSteps } from '@/lib/workflows/enricher';
import type {
    WorkflowStepV1,
    WorkflowStepV2,
    WorkflowVariable,
    WorkflowFileV2,
    EnrichmentHints,
    ActorKind,
    VariableSource,
} from '@/types/workflow-types';
import type { ModelConfig } from '@/types/ai-types';

interface Props {
    rawSteps: WorkflowStepV1[];
    initialName: string;
    modelConfig: ModelConfig | null;
    onSaved: (workflow: WorkflowFileV2) => void;
    onCancel: () => void;
}

const ACTOR_META: Record<ActorKind, { icon: React.ReactNode; label: string; color: string }> = {
    auto: { icon: <Bot20Regular />, label: 'Auto', color: tokens.colorPaletteGreenForeground1 },
    agent: { icon: <Sparkle20Regular />, label: 'Agent', color: tokens.colorPaletteBlueForeground2 },
    human: { icon: <Person20Regular />, label: 'Human', color: tokens.colorPaletteGoldForeground2 },
};

const SOURCE_LABELS: Record<VariableSource, string> = {
    conversation_context: 'From conversation',
    human_input: 'Ask user',
    literal: 'Fixed value',
    step_output: 'From step output',
};

const useStyles = makeStyles({
    root: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 8000,
    },
    dialog: {
        background: tokens.colorNeutralBackground1,
        borderRadius: '10px',
        boxShadow: '0 12px 48px rgba(0,0,0,0.32)',
        width: '640px',
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
    },
    header: {
        padding: '16px 20px 12px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    headerRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
    },
    body: {
        flex: 1,
        overflowY: 'auto',
        padding: '14px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
    },
    footer: {
        padding: '12px 20px',
        borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '10px',
    },
    section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
    },
    stepRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: '6px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        background: tokens.colorNeutralBackground2,
    },
    stepIndex: {
        minWidth: '22px',
        fontSize: '12px',
        color: tokens.colorNeutralForeground3,
        paddingTop: '8px',
        textAlign: 'right',
    },
    stepBody: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
    },
    actorRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
    },
    varRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: '6px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        background: tokens.colorNeutralBackground2,
    },
    varBody: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
    },
    loadingOverlay: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: '40px 20px',
    },
});

function ActorBadge({ actor }: { actor: ActorKind }) {
    const meta = ACTOR_META[actor];
    return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: meta.color, fontSize: '12px' }}>
            {meta.icon} {meta.label}
        </span>
    );
}

export function WorkflowRecordingReview({ rawSteps, initialName, modelConfig, onSaved, onCancel }: Props) {
    const styles = useStyles();

    const [enriching, setEnriching] = useState(true);
    const [hints, setHints] = useState<EnrichmentHints | null>(null);

    const [name, setName] = useState(initialName);
    const [description, setDescription] = useState('');
    const [goal, setGoal] = useState('');
    const [steps, setSteps] = useState<WorkflowStepV2[]>([]);
    const [variables, setVariables] = useState<WorkflowVariable[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!modelConfig) {
            // No model configured — use fallback immediately
            const fallback: EnrichmentHints = {
                suggestedName: initialName || 'my-workflow',
                description: '',
                goal: '',
                steps: rawSteps
                    .filter((s) => s.tool !== 'browser.observe')
                    .map((s, i) => ({
                        rawStepIndices: [i],
                        intent: '',
                        actor: (s.classification === 'destructive' ? 'human' : 'auto') as ActorKind,
                        requiresVariables: [],
                    })),
                variables: [],
            };
            setHints(fallback);
            populate(fallback);
            setEnriching(false);
            return;
        }

        enrichRecording(rawSteps, modelConfig)
            .then((h) => {
                setHints(h);
                populate(h);
            })
            .catch((err) => {
                console.warn('[WorkflowRecordingReview] enrichment error:', err);
            })
            .finally(() => setEnriching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function populate(h: EnrichmentHints) {
        if (h.suggestedName) setName(h.suggestedName);
        setDescription(h.description ?? '');
        setGoal(h.goal ?? '');
        setSteps(applyHintsToSteps(rawSteps, h));
        setVariables(
            h.variables.map((v) => ({
                name: v.name,
                type: 'string' as const,
                source: v.suggestedSource,
                description: `Value found in step ${v.foundInStep + 1}: "${v.hardcodedValue}"`,
                defaultValue: v.hardcodedValue,
            })),
        );
    }

    const updateStepIntent = useCallback((idx: number, intent: string) => {
        setSteps((prev) => {
            const next = [...prev];
            next[idx] = { ...next[idx], intent };
            return next;
        });
    }, []);

    const updateStepActor = useCallback((idx: number, actor: ActorKind) => {
        setSteps((prev) => {
            const next = [...prev];
            next[idx] = { ...next[idx], actor };
            return next;
        });
    }, []);

    const updateVarSource = useCallback((idx: number, source: VariableSource) => {
        setVariables((prev) => {
            const next = [...prev];
            next[idx] = { ...next[idx], source };
            return next;
        });
    }, []);

    const removeVar = useCallback((idx: number) => {
        setVariables((prev) => prev.filter((_, i) => i !== idx));
    }, []);

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            const slugify = (s: string) =>
                s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';

            const definition: WorkflowFileV2 = {
                version: 2,
                name: name.trim() || 'My Workflow',
                slug: slugify(name),
                description: description.trim(),
                goal: goal.trim(),
                createdAt: new Date().toISOString(),
                modelUsed: null,
                variables,
                steps,
            };
            const saved = await invoke<WorkflowFileV2>('workflow_recording_finalize', { definition });
            onSaved(saved);
        } catch (e) {
            setError(String(e));
        } finally {
            setSaving(false);
        }
    }, [name, description, goal, variables, steps, onSaved]);

    return (
        <div className={styles.root}>
            <div className={styles.dialog}>
                {/* Header */}
                <div className={styles.header}>
                    <div className={styles.headerRow}>
                        <CheckmarkCircle20Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
                        <Text weight="semibold" size={400}>Review recorded workflow</Text>
                        {enriching && <Spinner size="extra-tiny" label="Analysing with AI…" />}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                            Name
                        </Text>
                        <Input value={name} onChange={(_, d) => setName(d.value)} style={{ fontWeight: 600 }} />
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Description</Text>
                            <Input value={description} onChange={(_, d) => setDescription(d.value)} placeholder="What does this workflow do?" />
                        </div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Goal</Text>
                            <Input value={goal} onChange={(_, d) => setGoal(d.value)} placeholder="End state on success" />
                        </div>
                    </div>
                </div>

                {/* Body */}
                <div className={styles.body}>
                    {enriching && steps.length === 0 ? (
                        <div className={styles.loadingOverlay}>
                            <Spinner size="medium" />
                            <Text style={{ color: tokens.colorNeutralForeground3 }}>
                                Analysing {rawSteps.length} captured steps…
                            </Text>
                        </div>
                    ) : (
                        <>
                            {/* Variables section */}
                            {variables.length > 0 && (
                                <div className={styles.section}>
                                    <Text weight="semibold">
                                        Variables ({variables.length})
                                    </Text>
                                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                        These hardcoded values were detected and can be parameterised.
                                    </Text>
                                    {variables.map((v, i) => (
                                        <div key={v.name} className={styles.varRow}>
                                            <div className={styles.varBody}>
                                                <Text weight="semibold" size={200}>
                                                    {'{{ '}{v.name}{' }}'}
                                                </Text>
                                                <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                                                    {v.description}
                                                </Text>
                                            </div>
                                            <Select
                                                value={v.source}
                                                onChange={(_, d) => updateVarSource(i, d.value as VariableSource)}
                                                style={{ minWidth: 160 }}
                                            >
                                                {(Object.entries(SOURCE_LABELS) as [VariableSource, string][]).map(([src, label]) => (
                                                    <option key={src} value={src}>{label}</option>
                                                ))}
                                            </Select>
                                            <Button
                                                appearance="subtle"
                                                size="small"
                                                onClick={() => removeVar(i)}
                                                title="Remove variable (keep hardcoded value)"
                                            >
                                                ✕
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Steps section */}
                            <div className={styles.section}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <Text weight="semibold">Steps ({steps.length})</Text>
                                    <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                                        {rawSteps.length} raw steps → {steps.length} logical steps
                                    </Text>
                                </div>
                                {steps.map((step, i) => (
                                    <div key={step.id} className={styles.stepRow}>
                                        <span className={styles.stepIndex}>{i + 1}</span>
                                        <div className={styles.stepBody}>
                                            <Input
                                                value={step.intent}
                                                onChange={(_, d) => updateStepIntent(i, d.value)}
                                                placeholder="Describe what this step does…"
                                                style={{ fontWeight: 500 }}
                                            />
                                            <div className={styles.actorRow}>
                                                <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>Actor:</Text>
                                                {(['auto', 'agent', 'human'] as ActorKind[]).map((a) => (
                                                    <button
                                                        key={a}
                                                        onClick={() => updateStepActor(i, a)}
                                                        style={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 3,
                                                            padding: '2px 8px',
                                                            borderRadius: 4,
                                                            border: `1.5px solid ${step.actor === a ? ACTOR_META[a].color : tokens.colorNeutralStroke2}`,
                                                            background: step.actor === a ? `${ACTOR_META[a].color}18` : 'transparent',
                                                            color: step.actor === a ? ACTOR_META[a].color : tokens.colorNeutralForeground3,
                                                            fontSize: 11,
                                                            cursor: 'pointer',
                                                        }}
                                                    >
                                                        {ACTOR_META[a].icon}
                                                        {ACTOR_META[a].label}
                                                    </button>
                                                ))}
                                                <Text size={100} style={{ color: tokens.colorNeutralForeground4, marginLeft: 4 }}>
                                                    {step.tool} · {step.classification}
                                                </Text>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className={styles.footer}>
                    {error && (
                        <Text size={200} style={{ color: tokens.colorPaletteRedForeground1, flex: 1 }}>
                            <Warning20Regular style={{ verticalAlign: 'middle', marginRight: 4 }} />
                            {error}
                        </Text>
                    )}
                    <Button appearance="subtle" onClick={onCancel} disabled={saving}>
                        Cancel
                    </Button>
                    <Button
                        appearance="primary"
                        onClick={save}
                        disabled={saving || enriching || steps.length === 0}
                        icon={saving ? <Spinner size="tiny" /> : undefined}
                    >
                        {saving ? 'Saving…' : 'Save workflow'}
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default WorkflowRecordingReview;
