'use client';

// WorkflowEditor — cell-based workflow editor with drag-and-drop reordering.
//
// Replaces the one-shot WorkflowRecordingReview dialog with a persistent editor
// for viewing and editing workflow definitions. Supports add, remove, reorder,
// and inline edit of all step fields.
//
// Used from WorkflowsPanel for both:
//   1. Post-recording review (same entry point as WorkflowRecordingReview)
//   2. Editing an existing saved workflow (new "Edit" button)

import React, { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
    makeStyles,
    tokens,
    Text,
    Button,
    Input,
    Select,
    Spinner,
    Textarea,
} from '@fluentui/react-components';
import {
    CheckmarkCircle20Regular,
    Add16Regular,
    Dismiss16Regular,
    Save16Regular,
    Edit20Regular,
} from '@fluentui/react-icons';
import { StepCell } from './workflow/StepCell';
import type {
    WorkflowStepV2,
    WorkflowVariable,
    WorkflowFileV2,
    ActorKind,
} from '@/types/workflow-types';

interface Props {
    workflow: WorkflowFileV2;
    onSaved: (workflow: WorkflowFileV2) => void;
    onCancel: () => void;
}

const DEFAULT_RETRY = { maxAuto: 2, escalateTo: 'agent' as const };

function makeStepId(): string {
    return `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function emptyStep(): WorkflowStepV2 {
    return {
        id: makeStepId(),
        intent: '',
        tool: 'browser.observe',
        params: {},
        actor: 'auto',
        classification: 'read',
        retry: { ...DEFAULT_RETRY },
    };
}

const useStyles = makeStyles({
    overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 8000,
    },
    panel: {
        background: tokens.colorNeutralBackground1,
        borderRadius: '10px',
        boxShadow: '0 12px 48px rgba(0,0,0,0.32)',
        width: '700px',
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
    },
    header: {
        padding: '16px 20px 12px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
    },
    headerRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
    },
    metaRow: {
        display: 'flex',
        gap: '10px',
    },
    metaField: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
    },
    body: {
        flex: 1,
        overflowY: 'auto',
        padding: '14px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
    },
    footer: {
        padding: '12px 20px',
        borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '10px',
    },
    footerLeft: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
    },
    footerRight: {
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
    },
    sectionHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 0 4px',
    },
    // ── Variable row ──
    varChip: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 10px',
        borderRadius: '6px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        background: tokens.colorNeutralBackground2,
    },
    varName: {
        color: tokens.colorBrandForeground1,
        fontSize: '12px',
        fontWeight: 600,
    },
    varSource: {
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
    },
    addVarBtn: {
        fontSize: '11px',
        padding: '2px 8px',
    },
    emptyState: {
        textAlign: 'center',
        padding: '40px 20px',
        color: tokens.colorNeutralForeground3,
    },
});

export function WorkflowEditor({ workflow, onSaved, onCancel }: Props) {
    const styles = useStyles();

    const [name, setName] = useState(workflow.name);
    const [description, setDescription] = useState(workflow.description ?? '');
    const [goal, setGoal] = useState(workflow.goal ?? '');
    const [schedule, setSchedule] = useState(workflow.schedule ?? '');
    const [steps, setSteps] = useState<WorkflowStepV2[]>(workflow.steps);
    const [variables, setVariables] = useState<WorkflowVariable[]>(workflow.variables ?? []);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    // ── Step operations ──────────────────────────────────────────────────

    const updateStep = useCallback((index: number, updated: WorkflowStepV2) => {
        setSteps((prev) => {
            const next = [...prev];
            next[index] = updated;
            return next;
        });
    }, []);

    const removeStep = useCallback((index: number) => {
        setSteps((prev) => prev.filter((_, i) => i !== index));
    }, []);

    const addStep = useCallback(() => {
        setSteps((prev) => [...prev, emptyStep()]);
    }, []);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        setSteps((prev) => {
            const oldIndex = prev.findIndex((s) => s.id === active.id);
            const newIndex = prev.findIndex((s) => s.id === over.id);
            if (oldIndex === -1 || newIndex === -1) return prev;

            const next = [...prev];
            const [removed] = next.splice(oldIndex, 1);
            next.splice(newIndex, 0, removed);
            return next;
        });
    }, []);

    // ── Variable operations ──────────────────────────────────────────────

    const addVariable = useCallback(() => {
        setVariables((prev) => [
            ...prev,
            {
                name: '',
                type: 'string',
                source: 'human_input',
                defaultValue: '',
                description: '',
            },
        ]);
    }, []);

    const updateVariable = useCallback((index: number, patch: Partial<WorkflowVariable>) => {
        setVariables((prev) => {
            const next = [...prev];
            next[index] = { ...next[index], ...patch };
            return next;
        });
    }, []);

    const removeVariable = useCallback((index: number) => {
        setVariables((prev) => prev.filter((_, i) => i !== index));
    }, []);

    // ── Save ─────────────────────────────────────────────────────────────

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            const slugify = (s: string) =>
                s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';

            const definition: WorkflowFileV2 = {
                version: 2,
                name: name.trim() || 'My Workflow',
                slug: workflow.slug || slugify(name),
                description: description.trim(),
                goal: goal.trim(),
                schedule: schedule.trim() || undefined,
                createdAt: workflow.createdAt || new Date().toISOString(),
                modelUsed: workflow.modelUsed ?? null,
                variables,
                steps,
            };

            const saved = await invoke<WorkflowFileV2>('workflow_update', { definition });
            onSaved(saved);
        } catch (e) {
            setError(String(e));
        } finally {
            setSaving(false);
        }
    }, [name, description, goal, schedule, variables, steps, workflow.slug, workflow.createdAt, workflow.modelUsed, onSaved]);

    return (
        <div className={styles.overlay}>
            <div className={styles.panel}>
                {/* Header */}
                <div className={styles.header}>
                    <div className={styles.headerRow}>
                        <Edit20Regular style={{ color: tokens.colorBrandForeground1 }} />
                        <Text weight="semibold" size={400}>Edit workflow</Text>
                    </div>
                    <Input
                        value={name}
                        onChange={(_, d) => setName(d.value)}
                        placeholder="Workflow name"
                        style={{ fontWeight: 600 }}
                    />
                    <div className={styles.metaRow}>
                        <div className={styles.metaField}>
                            <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>Description</Text>
                            <Input
                                value={description}
                                onChange={(_, d) => setDescription(d.value)}
                                placeholder="What does this workflow do?"
                                size="small"
                            />
                        </div>
                        <div className={styles.metaField}>
                            <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>Goal</Text>
                            <Input
                                value={goal}
                                onChange={(_, d) => setGoal(d.value)}
                                placeholder="End state on success"
                                size="small"
                            />
                        </div>
                        <div className={styles.metaField} style={{ flex: 0.8 }}>
                            <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>Schedule (cron)</Text>
                            <Input
                                value={schedule}
                                onChange={(_, d) => setSchedule(d.value)}
                                placeholder="0 2 * * *"
                                size="small"
                            />
                        </div>
                    </div>
                </div>

                {/* Body */}
                <div className={styles.body}>
                    {/* Variables */}
                    {variables.length > 0 && (
                        <>
                            <div className={styles.sectionHeader}>
                                <Text weight="semibold" size={200}>Variables ({variables.length})</Text>
                            </div>
                            {variables.map((v, i) => (
                                <div key={v.name || i} className={styles.varChip}>
                                    <Input
                                        value={v.name}
                                        onChange={(_, d) => updateVariable(i, { name: d.value })}
                                        placeholder="var_name"
                                        size="small"
                                        style={{ minWidth: 100, flex: 1 }}
                                    />
                                    <Select
                                        value={v.source}
                                        onChange={(_, d) => updateVariable(i, { source: d.value as 'human_input' | 'conversation_context' | 'literal' | 'step_output' })}
                                        size="small"
                                    >
                                        <option value="human_input">Ask user</option>
                                        <option value="conversation_context">From context</option>
                                        <option value="literal">Fixed</option>
                                        <option value="step_output">Step output</option>
                                    </Select>
                                    <Button
                                        size="small"
                                        appearance="subtle"
                                        onClick={() => removeVariable(i)}
                                    >
                                        ✕
                                    </Button>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Steps */}
                    <div className={styles.sectionHeader}>
                        <Text weight="semibold">Steps ({steps.length})</Text>
                        <Button
                            size="small"
                            appearance="subtle"
                            icon={<Add16Regular />}
                            onClick={addStep}
                        >
                            Add step
                        </Button>
                    </div>

                    {steps.length === 0 ? (
                        <div className={styles.emptyState}>
                            <Text>No steps yet. Click <strong>Add step</strong> to begin.</Text>
                        </div>
                    ) : (
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragEnd={handleDragEnd}
                        >
                            <SortableContext
                                items={steps.map((s) => s.id)}
                                strategy={verticalListSortingStrategy}
                            >
                                {steps.map((step, i) => (
                                    <StepCell
                                        key={step.id}
                                        step={step}
                                        index={i}
                                        onChange={(updated) => updateStep(i, updated)}
                                        onRemove={() => removeStep(i)}
                                    />
                                ))}
                            </SortableContext>
                        </DndContext>
                    )}
                </div>

                {/* Footer */}
                <div className={styles.footer}>
                    <div className={styles.footerLeft}>
                        <Button
                            size="small"
                            appearance="subtle"
                            icon={<Add16Regular />}
                            onClick={addVariable}
                        >
                            Add variable
                        </Button>
                    </div>
                    <div className={styles.footerRight}>
                        {error && (
                            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                {error}
                            </Text>
                        )}
                        <Button appearance="subtle" onClick={onCancel} disabled={saving}>
                            Cancel
                        </Button>
                        <Button
                            appearance="primary"
                            icon={saving ? <Spinner size="tiny" /> : <Save16Regular />}
                            onClick={save}
                            disabled={saving || steps.length === 0}
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default WorkflowEditor;
