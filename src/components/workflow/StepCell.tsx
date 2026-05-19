'use client';

import React, { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    makeStyles,
    tokens,
    Text,
    Input,
    Textarea,
    Select,
    Dropdown,
    Option,
    OptionGroup,
    Button,
} from '@fluentui/react-components';
import {
    Drag20Regular,
    ChevronDown12Regular,
    ChevronUp12Regular,
    Bot16Regular,
    Sparkle16Regular,
    Person16Regular,
} from '@fluentui/react-icons';
import type { WorkflowStepV2, ActorKind, RetryPolicy, Postcondition } from '@/types/workflow-types';
import { useAvailableTools, type ToolInfo } from '@/lib/workflows/use-available-tools';

interface StepCellProps {
    step: WorkflowStepV2;
    index: number;
    onChange(updated: WorkflowStepV2): void;
    onRemove(): void;
}

const ACTOR_OPTIONS: { value: ActorKind; label: string; icon: React.ReactNode }[] = [
    { value: 'auto', label: 'Auto', icon: <Bot16Regular /> },
    { value: 'agent', label: 'Agent', icon: <Sparkle16Regular /> },
    { value: 'human', label: 'Human', icon: <Person16Regular /> },
];

const ACTOR_COLOR: Record<ActorKind, string> = {
    auto: tokens.colorPaletteGreenForeground1,
    agent: tokens.colorPaletteBlueForeground2,
    human: tokens.colorPaletteGoldForeground2,
};

const useStyles = makeStyles({
    cell: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        padding: '8px 10px',
        borderRadius: '6px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        background: tokens.colorNeutralBackground1,
        marginBottom: '6px',
        position: 'relative',
    },
    dragging: {
        opacity: 0.5,
        boxShadow: tokens.shadow8,
    },
    dragHandle: {
        cursor: 'grab',
        color: tokens.colorNeutralForeground3,
        display: 'flex',
        alignItems: 'center',
        paddingTop: '6px',
        flexShrink: 0,
        ':active': { cursor: 'grabbing' },
    },
    indexCol: {
        minWidth: '22px',
        fontSize: '12px',
        color: tokens.colorNeutralForeground3,
        paddingTop: '8px',
        textAlign: 'right',
        flexShrink: 0,
    },
    body: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
    },
    topRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
    },
    intentInput: {
        flex: 1,
    },
    toolRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
    },
    expandBtn: {
        background: 'none',
        border: 'none',
        padding: '2px 4px',
        cursor: 'pointer',
        color: tokens.colorNeutralForeground3,
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        fontSize: '11px',
        ':hover': { color: tokens.colorNeutralForeground1 },
    },
    details: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        paddingTop: '4px',
    },
    detailRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
    },
    detailLabel: {
        minWidth: '80px',
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
        paddingTop: '4px',
        flexShrink: 0,
    },
    detailField: {
        flex: 1,
    },
    actorRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
    },
    actorBtn: {
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        padding: '2px 8px',
        borderRadius: '4px',
        border: '1.5px solid',
        fontSize: '11px',
        cursor: 'pointer',
    },
    removeBtn: {
        color: tokens.colorPaletteRedForeground1,
        flexShrink: 0,
        paddingTop: '4px',
    },
});

export function StepCell({ step, index, onChange, onRemove }: StepCellProps) {
    const styles = useStyles();
    const [expanded, setExpanded] = useState(false);
    const { toolsByCategory } = useAvailableTools();

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: step.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const update = (patch: Partial<WorkflowStepV2>) => {
        onChange({ ...step, ...patch });
    };

    const updateParams = (raw: string) => {
        try {
            const parsed = JSON.parse(raw);
            update({ params: parsed as Record<string, unknown> });
        } catch {
            // keep old params if parse fails — user is mid-edit
        }
    };

    const updateRetry = (patch: Partial<RetryPolicy>) => {
        update({ retry: { ...step.retry, ...patch } });
    };

    const updatePostcondition = (patch: Partial<Postcondition>) => {
        if (step.postcondition) {
            update({ postcondition: { ...step.postcondition, ...patch } });
        } else {
            update({ postcondition: { type: 'none', value: '', timeoutMs: 5000, ...patch } });
        }
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${styles.cell} ${isDragging ? styles.dragging : ''}`}
        >
            <div className={styles.dragHandle} {...attributes} {...listeners}>
                <Drag20Regular />
            </div>
            <span className={styles.indexCol}>{index + 1}</span>
            <div className={styles.body}>
                <div className={styles.topRow}>
                    <Input
                        className={styles.intentInput}
                        value={step.intent}
                        onChange={(_, d) => update({ intent: d.value })}
                        placeholder="Describe what this step does…"
                        size="small"
                    />
                    <Button
                        size="small"
                        appearance="subtle"
                        className={styles.removeBtn}
                        onClick={onRemove}
                    >
                        ✕
                    </Button>
                </div>

                <div className={styles.toolRow}>
                    <Input
                        value={step.tool}
                        onChange={(_, d) => update({ tool: d.value })}
                        placeholder="browser.toolName"
                        size="small"
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <Dropdown
                        size="small"
                        placeholder="Pick tool…"
                        style={{ width: '140px', flexShrink: 0 }}
                        onOptionSelect={(_, data) => {
                            if (data.optionValue) update({ tool: data.optionValue });
                        }}
                    >
                        {toolsByCategory.map(group => (
                            <OptionGroup key={group.category} label={group.category}>
                                {group.tools.map(t => (
                                    <Option key={t.name} value={t.name}>{t.name}</Option>
                                ))}
                            </OptionGroup>
                        ))}
                    </Dropdown>
                    <span style={{ color: tokens.colorNeutralForeground3, fontSize: '11px' }}>
                        {step.classification}
                    </span>
                    <button className={styles.expandBtn} onClick={() => setExpanded((e) => !e)}>
                        {expanded ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
                        {expanded ? 'Less' : 'More'}
                    </button>
                </div>

                <div className={styles.actorRow}>
                    {ACTOR_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            onClick={() => update({ actor: opt.value })}
                            className={styles.actorBtn}
                            style={{
                                borderColor: step.actor === opt.value ? ACTOR_COLOR[opt.value] : tokens.colorNeutralStroke2,
                                background: step.actor === opt.value ? `${ACTOR_COLOR[opt.value]}18` : 'transparent',
                                color: step.actor === opt.value ? ACTOR_COLOR[opt.value] : tokens.colorNeutralForeground3,
                            }}
                        >
                            {opt.icon}
                            {opt.label}
                        </button>
                    ))}
                </div>

                {expanded && (
                    <div className={styles.details}>
                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Description</Text>
                            <Textarea
                                className={styles.detailField}
                                value={step.description ?? ''}
                                onChange={(_, d) => update({ description: d.value || undefined })}
                                placeholder="Explain what this step does and why…"
                                rows={2}
                                size="small"
                            />
                        </div>

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Failure hints</Text>
                            <Textarea
                                className={styles.detailField}
                                value={(step.failureHints ?? []).join('\n')}
                                onChange={(_, d) => update({ failureHints: d.value ? d.value.split('\n').filter(Boolean) : undefined })}
                                placeholder="One troubleshooting hint per line…"
                                rows={2}
                                size="small"
                            />
                        </div>

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Params</Text>
                            <Textarea
                                className={styles.detailField}
                                value={JSON.stringify(step.params, null, 2)}
                                onChange={(_, d) => updateParams(d.value)}
                                placeholder="{ }"
                                rows={3}
                                size="small"
                            />
                        </div>

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Retry</Text>
                            <div className={styles.detailField} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <Input
                                    type="number"
                                    value={String(step.retry.maxAuto)}
                                    onChange={(_, d) => updateRetry({ maxAuto: Math.max(0, parseInt(d.value, 10) || 0) })}
                                    size="small"
                                    style={{ width: '80px' }}
                                />
                                <Select
                                    value={step.retry.escalateTo}
                                    onChange={(_, d) => updateRetry({ escalateTo: d.value as 'agent' | 'human' | 'abort' })}
                                    size="small"
                                >
                                    <option value="agent">→ Agent</option>
                                    <option value="human">→ Human</option>
                                    <option value="abort">→ Abort</option>
                                </Select>
                            </div>
                        </div>

                        <div className={styles.detailRow}>
                            <Text className={styles.detailLabel}>Postcond.</Text>
                            <div className={styles.detailField} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                                <Select
                                    value={step.postcondition?.type ?? 'none'}
                                    onChange={(_, d) => {
                                        if (d.value === 'none') {
                                            update({ postcondition: undefined });
                                        } else {
                                            updatePostcondition({ type: d.value as Postcondition['type'] });
                                        }
                                    }}
                                    size="small"
                                >
                                    <option value="none">None</option>
                                    <option value="url_pattern">URL pattern</option>
                                    <option value="selector_exists">Selector exists</option>
                                    <option value="text_contains">Text contains</option>
                                </Select>
                                {step.postcondition && step.postcondition.type !== 'none' && (
                                    <>
                                        <Input
                                            value={step.postcondition.value}
                                            onChange={(_, d) => updatePostcondition({ value: d.value })}
                                            placeholder="Value"
                                            size="small"
                                            style={{ minWidth: 140, flex: 1 }}
                                        />
                                        <Input
                                            type="number"
                                            value={String(step.postcondition.timeoutMs)}
                                            onChange={(_, d) => updatePostcondition({ timeoutMs: parseInt(d.value, 10) || 5000 })}
                                            size="small"
                                            style={{ width: '80px' }}
                                        />
                                    </>
                                )}
                            </div>
                        </div>

                        {step.actor === 'agent' && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Agent hint</Text>
                                <Textarea
                                    className={styles.detailField}
                                    value={step.retry.agentHint ?? ''}
                                    onChange={(_, d) => updateRetry({ agentHint: d.value })}
                                    placeholder="Instructions for the LLM when this step fails…"
                                    rows={2}
                                    size="small"
                                />
                            </div>
                        )}

                        {step.actor === 'human' && (
                            <div className={styles.detailRow}>
                                <Text className={styles.detailLabel}>Human prompt</Text>
                                <Textarea
                                    className={styles.detailField}
                                    value={step.humanPrompt ?? ''}
                                    onChange={(_, d) => update({ humanPrompt: d.value })}
                                    placeholder="Instructions shown to the user…"
                                    rows={2}
                                    size="small"
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default StepCell;
