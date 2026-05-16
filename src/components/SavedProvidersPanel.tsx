'use client';

import React from 'react';
import {
    makeStyles,
    tokens,
    shorthands,
    Text,
    Button,
    Input,
    Label,
    Badge,
    Field,
    Spinner,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    DialogActions,
} from '@fluentui/react-components';
import {
    Add12Regular,
    Delete16Regular,
    Checkmark16Regular,
    Edit16Regular,
    Play16Regular,
} from '@fluentui/react-icons';
import { AIMode, MessageRole, ModelConfig, ModelProvider, SavedOpenAIProvider } from '@/types/ai-types';
import {
    listSavedProviders,
    upsertSavedProvider,
    deleteSavedProvider,
    setDefaultProvider,
    setActiveProviderId,
    getActiveProviderId,
    validateProvider,
} from '@/lib/ai/savedProviders';
import { runInference, createMessage } from '@/lib/ai/ai-service';
import {
    COMMON_CONTEXT_WINDOWS,
    DEFAULT_CONTEXT_WINDOW,
    computeMemoryBudget,
    formatTokens,
    suggestContextWindow,
} from '@/lib/ai/memory/budget';

interface ContextWindowFieldProps {
    modelName: string;
    value: number | undefined;
    onChange: (next: number | undefined) => void;
}

const ContextWindowField: React.FC<ContextWindowFieldProps> = ({ modelName, value, onChange }) => {
    const suggestion = React.useMemo(() => suggestContextWindow(modelName), [modelName]);
    const effective = value ?? DEFAULT_CONTEXT_WINDOW;
    const budget = React.useMemo(() => computeMemoryBudget(effective, 2048), [effective]);
    const isDefaulted = value === undefined;

    const parseInput = (raw: string): number | undefined => {
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        const n = parseInt(trimmed, 10);
        if (Number.isNaN(n) || n <= 0) return undefined;
        return n;
    };

    return (
        <Field
            label="Context window"
            hint={
                isDefaulted
                    ? `Falls back to ${formatTokens(DEFAULT_CONTEXT_WINDOW)}. Summarize at ~${formatTokens(budget.summarizeThreshold)}, trim history to ${formatTokens(budget.historyBudget)}.`
                    : `Summarize at ~${formatTokens(budget.summarizeThreshold)}, trim history to ${formatTokens(budget.historyBudget)} (output reserve ${formatTokens(budget.reservedOutputTokens)}).`
            }
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <Input
                        type="number"
                        value={value === undefined ? '' : String(value)}
                        placeholder={`auto (${formatTokens(DEFAULT_CONTEXT_WINDOW)})`}
                        onChange={(_, data) => onChange(parseInput(data.value))}
                        style={{ maxWidth: '180px' }}
                    />
                    {suggestion && value !== suggestion.tokens && (
                        <Button
                            size="small"
                            appearance="subtle"
                            onClick={() => onChange(suggestion.tokens)}
                        >
                            Use {formatTokens(suggestion.tokens)} ({suggestion.label})
                        </Button>
                    )}
                    {value !== undefined && (
                        <Button size="small" appearance="subtle" onClick={() => onChange(undefined)}>
                            Reset
                        </Button>
                    )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {COMMON_CONTEXT_WINDOWS.map((c) => (
                        <Badge
                            key={c.tokens}
                            appearance={value === c.tokens ? 'filled' : 'outline'}
                            size="small"
                            color={value === c.tokens ? 'brand' : 'subtle'}
                            style={{ cursor: 'pointer' }}
                            onClick={() => onChange(c.tokens)}
                        >
                            {c.label}
                        </Badge>
                    ))}
                </div>
            </div>
        </Field>
    );
};

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('12px'),
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        ...shorthands.gap('8px'),
    },
    list: {
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('6px'),
    },
    row: {
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.padding('10px', '12px'),
        ...shorthands.borderRadius('8px'),
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
        backgroundColor: tokens.colorNeutralBackground1,
        cursor: 'pointer',
        position: 'relative',
        transition: 'background-color 0.15s, border-color 0.15s',
        ':hover': {
            backgroundColor: tokens.colorNeutralBackground2,
            borderLeftColor: tokens.colorBrandStroke1,
        },
        ':hover > .row-actions': { opacity: 1 },
    },
    rowActive: {
        ...shorthands.borderLeft('3px', 'solid', tokens.colorBrandForeground1),
        backgroundColor: tokens.colorBrandBackground2,
    },
    rowTopLine: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
    },
    rowName: {
        fontSize: '14px',
        fontWeight: 600,
    },
    rowMeta: {
        fontSize: '12px',
        color: tokens.colorNeutralForeground3,
        marginTop: '2px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    rowActions: {
        position: 'absolute',
        top: '6px',
        right: '6px',
        display: 'flex',
        ...shorthands.gap('4px'),
        opacity: 0,
        transition: 'opacity 0.15s',
    },
    empty: {
        ...shorthands.padding('24px', '16px'),
        textAlign: 'center',
        color: tokens.colorNeutralForeground3,
        ...shorthands.borderRadius('8px'),
        ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke2),
    },
    form: {
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('12px'),
        ...shorthands.padding('16px'),
        ...shorthands.borderRadius('8px'),
        backgroundColor: tokens.colorNeutralBackground2,
    },
    formActions: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: '4px',
    },
    formActionsRight: {
        display: 'flex',
        ...shorthands.gap('8px'),
    },
});

interface SavedProvidersPanelProps {
    onChange?: () => void;
    onEditingStateChange?: (editing: boolean) => void;
}

interface TestResult {
    ok: boolean;
    message: string;
}

interface FormState {
    id?: string;
    name: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
    isDefault: boolean;
    contextWindow?: number;
    supportsVision: boolean;
}

const emptyForm: FormState = {
    name: '',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey: '',
    modelName: '',
    isDefault: false,
    contextWindow: undefined,
    supportsVision: false,
};

export function SavedProvidersPanel({ onChange, onEditingStateChange }: SavedProvidersPanelProps) {
    const styles = useStyles();
    const [providers, setProviders] = React.useState<SavedOpenAIProvider[]>([]);
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<FormState | null>(null);
    const [errors, setErrors] = React.useState<Partial<Record<'name' | 'endpoint' | 'modelName', string>>>({});
    const [pendingDelete, setPendingDelete] = React.useState<SavedOpenAIProvider | null>(null);
    const [testing, setTesting] = React.useState<boolean>(false);
    const [testResult, setTestResult] = React.useState<TestResult | null>(null);

    React.useEffect(() => {
        onEditingStateChange?.(editing !== null);
    }, [editing, onEditingStateChange]);

    const refresh = React.useCallback(() => {
        setProviders(listSavedProviders());
        setActiveId(getActiveProviderId());
    }, []);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    const notify = React.useCallback(() => {
        refresh();
        onChange?.();
    }, [refresh, onChange]);

    const startNew = () => {
        setErrors({});
        setTestResult(null);
        setEditing({ ...emptyForm, isDefault: providers.length === 0 });
    };

    const startEdit = (p: SavedOpenAIProvider) => {
        setErrors({});
        setTestResult(null);
        setEditing({
            id: p.id,
            name: p.name,
            endpoint: p.endpoint,
            apiKey: p.apiKey,
            modelName: p.modelName,
            isDefault: p.isDefault,
            contextWindow: p.contextWindow,
            supportsVision: !!p.supportsVision,
        });
    };

    const cancelEdit = () => {
        setEditing(null);
        setErrors({});
        setTestResult(null);
    };

    const runTestConnection = async () => {
        if (!editing) return;
        // Light validation: a test only needs endpoint + modelName.
        const fieldErrors: typeof errors = {};
        if (!editing.endpoint.trim()) fieldErrors.endpoint = 'Endpoint URL is required.';
        else if (!/^https?:\/\/.+/i.test(editing.endpoint.trim())) fieldErrors.endpoint = 'Endpoint must start with http:// or https://.';
        if (!editing.modelName.trim()) fieldErrors.modelName = 'Model name is required.';
        if (Object.keys(fieldErrors).length > 0) {
            setErrors(fieldErrors);
            return;
        }
        setErrors({});
        setTesting(true);
        setTestResult(null);

        const testConfig: ModelConfig = {
            id: 'preset-test',
            name: editing.name || 'Test',
            provider: ModelProvider.OpenAICompatible,
            modelId: editing.modelName.trim(),
            parameters: {
                temperature: 0.2,
                topP: 0.9,
                maxTokens: 32,
                stream: false,
            },
            endpoint: editing.endpoint.trim(),
            apiKey: editing.apiKey || undefined,
            isAvailable: true,
            recommendedFor: [AIMode.Agent],
        };

        try {
            const response = await runInference({
                sessionId: 'preset-test',
                modelConfig: testConfig,
                messages: [createMessage(MessageRole.User, 'Reply with the single word: ok.')],
                mode: AIMode.Agent,
            });
            const text = (response.message.content || '').trim().slice(0, 80);
            setTestResult({ ok: true, message: text ? `Connected. Model replied: "${text}"` : 'Connected. Empty response.' });
        } catch (err: unknown) {
            const message = err instanceof Error
                ? err.message
                : typeof err === 'string' ? err : 'Unknown error';
            setTestResult({ ok: false, message });
        } finally {
            setTesting(false);
        }
    };

    const saveEdit = () => {
        if (!editing) return;
        const validation = validateProvider(
            {
                id: editing.id,
                name: editing.name,
                endpoint: editing.endpoint,
                apiKey: editing.apiKey,
                modelName: editing.modelName,
                isDefault: editing.isDefault,
            },
            providers,
        );
        if (!validation.ok) {
            setErrors(validation.errors);
            return;
        }
        const saved = upsertSavedProvider({
            id: editing.id,
            name: editing.name,
            endpoint: editing.endpoint,
            apiKey: editing.apiKey,
            modelName: editing.modelName,
            isDefault: editing.isDefault,
            contextWindow: editing.contextWindow,
            supportsVision: editing.supportsVision,
        });
        if (!getActiveProviderId()) {
            setActiveProviderId(saved.id);
        }
        setEditing(null);
        setErrors({});
        notify();
    };

    const confirmDelete = () => {
        if (!pendingDelete) return;
        deleteSavedProvider(pendingDelete.id);
        setPendingDelete(null);
        notify();
    };

    const promoteDefault = (e: React.MouseEvent, p: SavedOpenAIProvider) => {
        e.stopPropagation();
        setDefaultProvider(p.id);
        notify();
    };

    const selectActive = (p: SavedOpenAIProvider) => {
        setActiveProviderId(p.id);
        notify();
    };

    if (editing) {
        return (
            <div className={styles.root}>
                <Text size={400} weight="semibold">
                    {editing.id ? 'Edit preset' : 'New preset'}
                </Text>
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                    Save the endpoint, API key, and model name for an OpenAI-compatible service so you can switch profiles without retyping.
                </Text>

                <div className={styles.form}>
                    <Field
                        label="Name"
                        required
                        validationState={errors.name ? 'error' : 'none'}
                        validationMessage={errors.name}
                    >
                        <Input
                            value={editing.name}
                            placeholder="e.g., OpenRouter — Sonnet 4"
                            onChange={(_, data) => setEditing({ ...editing, name: data.value })}
                        />
                    </Field>

                    <Field
                        label="Endpoint URL"
                        required
                        validationState={errors.endpoint ? 'error' : 'none'}
                        validationMessage={errors.endpoint ?? 'Full base URL including the version segment. We append /chat/completions to it — no magic.'}
                    >
                        <Input
                            value={editing.endpoint}
                            placeholder="https://openrouter.ai/api/v1"
                            onChange={(_, data) => setEditing({ ...editing, endpoint: data.value })}
                        />
                    </Field>

                    <Field
                        label="API Key"
                        hint="Leave blank for local servers that don't require auth."
                    >
                        <Input
                            type="password"
                            value={editing.apiKey}
                            placeholder="sk-or-v1-…"
                            onChange={(_, data) => setEditing({ ...editing, apiKey: data.value })}
                        />
                    </Field>

                    <Field
                        label="Model name"
                        required
                        validationState={errors.modelName ? 'error' : 'none'}
                        validationMessage={errors.modelName ?? 'The identifier sent as `model` in the request.'}
                    >
                        <Input
                            value={editing.modelName}
                            placeholder="anthropic/claude-sonnet-4"
                            onChange={(_, data) => setEditing({ ...editing, modelName: data.value })}
                        />
                    </Field>

                    <ContextWindowField
                        modelName={editing.modelName}
                        value={editing.contextWindow}
                        onChange={(v) => setEditing({ ...editing, contextWindow: v })}
                    />

                    <Label>
                        <input
                            type="checkbox"
                            checked={editing.isDefault}
                            onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })}
                            style={{ marginRight: '8px' }}
                        />
                        Use as default on app start
                    </Label>

                    <div>
                        <Label>
                            <input
                                type="checkbox"
                                checked={editing.supportsVision}
                                onChange={(e) => setEditing({ ...editing, supportsVision: e.target.checked })}
                                style={{ marginRight: '8px' }}
                            />
                            Model supports vision (image inputs)
                        </Label>
                        <Text size={200} style={{ display: 'block', color: tokens.colorNeutralForeground3, marginLeft: '24px' }}>
                            Required for the browser-use harness — without it, browser tools stay hidden from the agent. Examples: Claude Sonnet 4.6 / Opus 4.7, GPT-4o, Qwen2.5-VL.
                        </Text>
                    </div>
                </div>

                {testResult && (
                    <div
                        style={{
                            padding: '10px 12px',
                            borderRadius: '6px',
                            backgroundColor: testResult.ok
                                ? tokens.colorPaletteGreenBackground1
                                : tokens.colorPaletteRedBackground1,
                            color: testResult.ok
                                ? tokens.colorPaletteGreenForeground1
                                : tokens.colorPaletteRedForeground1,
                            fontSize: '12px',
                            wordBreak: 'break-word',
                        }}
                    >
                        {testResult.ok ? '✅ ' : '❌ '}
                        {testResult.message}
                    </div>
                )}

                <div className={styles.formActions}>
                    <Button
                        appearance="outline"
                        icon={testing ? <Spinner size="tiny" /> : <Play16Regular />}
                        onClick={runTestConnection}
                        disabled={testing}
                    >
                        {testing ? 'Testing…' : 'Test connection'}
                    </Button>
                    <div className={styles.formActionsRight}>
                        <Button appearance="secondary" onClick={cancelEdit} disabled={testing}>
                            Cancel
                        </Button>
                        <Button appearance="primary" onClick={saveEdit} disabled={testing}>
                            Save preset
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <div>
                    <Text size={400} weight="semibold" block>
                        Saved providers
                    </Text>
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        Reusable presets for OpenAI-compatible endpoints. Switch profiles from the chat header.
                    </Text>
                </div>
                <Button
                    appearance="primary"
                    icon={<Add12Regular />}
                    onClick={startNew}
                    style={{ whiteSpace: 'nowrap' }}
                >
                    New preset
                </Button>
            </div>

            {providers.length === 0 ? (
                <div className={styles.empty}>
                    <Text block size={300} weight="semibold" style={{ marginBottom: '4px' }}>
                        No presets yet
                    </Text>
                    <Text block size={200}>
                        Create one to save an endpoint, API key, and model name together.
                    </Text>
                </div>
            ) : (
                <div className={styles.list}>
                    {providers.map((p) => {
                        const isActive = p.id === activeId;
                        return (
                            <div
                                key={p.id}
                                className={`${styles.row} ${isActive ? styles.rowActive : ''}`}
                                onClick={() => selectActive(p)}
                                role="button"
                                tabIndex={0}
                            >
                                <div className={styles.rowTopLine}>
                                    <Text className={styles.rowName}>{p.name}</Text>
                                    {p.isDefault && (
                                        <Badge appearance="tint" color="brand" size="small">
                                            Default
                                        </Badge>
                                    )}
                                    {isActive && !p.isDefault && (
                                        <Badge appearance="outline" size="small">
                                            Active
                                        </Badge>
                                    )}
                                </div>
                                <Text className={styles.rowMeta} title={`${p.modelName} · ${p.endpoint}`}>
                                    {p.modelName} · {p.endpoint}
                                </Text>
                                <div className={`${styles.rowActions} row-actions`}>
                                    {!p.isDefault && (
                                        <Button
                                            appearance="subtle"
                                            size="small"
                                            icon={<Checkmark16Regular />}
                                            onClick={(e) => promoteDefault(e, p)}
                                            title="Set as default"
                                            aria-label="Set as default"
                                        />
                                    )}
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        icon={<Edit16Regular />}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            startEdit(p);
                                        }}
                                        title="Edit preset"
                                        aria-label="Edit preset"
                                    />
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        icon={<Delete16Regular />}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setPendingDelete(p);
                                        }}
                                        title="Delete preset"
                                        aria-label="Delete preset"
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <Dialog
                open={pendingDelete !== null}
                onOpenChange={(_, data) => !data.open && setPendingDelete(null)}
            >
                <DialogSurface>
                    <DialogBody>
                        <DialogTitle>Delete this preset?</DialogTitle>
                        <DialogContent>
                            <Text>
                                &ldquo;{pendingDelete?.name}&rdquo; will be removed. The API key
                                is deleted from local storage and cannot be recovered.
                            </Text>
                        </DialogContent>
                        <DialogActions>
                            <Button appearance="secondary" onClick={() => setPendingDelete(null)}>
                                Cancel
                            </Button>
                            <Button appearance="primary" onClick={confirmDelete}>
                                Delete
                            </Button>
                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>
        </div>
    );
}

export function useSavedProvidersBridge() {
    const [version, setVersion] = React.useState(0);
    const bump = React.useCallback(() => setVersion((v) => v + 1), []);
    return { version, bump };
}
