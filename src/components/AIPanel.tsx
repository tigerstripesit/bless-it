'use client';

/**
 * AI Panel Component
 * 
 * Main AI panel that integrates chat, mode selector, and model selector.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    makeStyles,
    tokens,
    shorthands,
    Text,
    Button,
    Spinner,
} from '@fluentui/react-components';
import { AISettingsPanel } from './AISettingsPanel';
import { ModelSelector } from './ModelSelector';
import {
    Settings24Regular,
    PanelLeftExpand24Regular,
} from '@fluentui/react-icons';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AIChat } from './AIChat';
import { HistorySidebar } from './HistorySidebar';
import {
    AIMode,
    ChatMessage,
    MessageRole,
    ModelConfig,
    FileSystemContext,
    ModelProvider,
    SavedOpenAIProvider,
    SkillManifest,
    ToolExecutionData,
} from '@/types/ai-types';
import {
    listSavedProviders,
    getActiveProvider,
    getActiveProviderId,
    setActiveProviderId,
    migrateLegacySingleConfig,
} from '@/lib/ai/savedProviders';
import { featureFlags } from '@/lib/featureFlags';
import {
    getProvidersStatus,
    runInference,
    createMessage,
    getDefaultModelForMode,
} from '@/lib/ai/ai-service';
import { aiConfig, getDefaultEndpoint, loadAIConfig } from '@/lib/ai/config';
import { runInferenceWithTools } from '@/lib/ai/inference-with-tools';
import { removeToolCallTags } from '@/lib/ai/tool-calling';
import {
    createConversation,
    appendMessage as persistAppendMessage,
    loadConversation,
    fromStoredMessage,
    updateConversationSummary,
} from '@/lib/conversations/store';
import {
    applySummaryToOutgoing,
    generateConversationSummary,
    shouldSummarize,
    SummaryState,
} from '@/lib/ai/memory/summary';
import { extractFactsFromConversation, mergeUserProfileFacts } from '@/lib/ai/memory/profile';
import { refreshUserProfileCache } from '@/lib/ai/memory/profile-cache';
import { computeMemoryBudget, suggestContextWindow } from '@/lib/ai/memory/budget';
import {
    listSkills,
    loadSkillBody,
    formatSkillCatalog,
    parseSkillInvocation,
} from '@/lib/skills/store';

const useStyles = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.borderLeft('1px', 'solid', tokens.colorNeutralStroke1),
    },
    mainColumn: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
    },
    header: {
        ...shorthands.padding('12px', '16px'),
        backgroundColor: tokens.colorNeutralBackground2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        ...shorthands.gap('12px'),
    },
    headerLeft: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('12px'),
        flex: 1,
    },
    headerRight: {
        display: 'flex',
        ...shorthands.gap('8px'),
        alignItems: 'center',
    },
    chatContainer: {
        flex: 1,
        minHeight: 0,
    },
    loadingContainer: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        ...shorthands.gap('12px'),
    },
    confirmOverlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
    },
    confirmDialog: {
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.borderRadius('12px'),
        ...shorthands.padding('24px'),
        maxWidth: '500px',
        width: '90%',
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('16px'),
        boxShadow: tokens.shadow64,
    },
    confirmTitle: {
        fontSize: '16px',
        fontWeight: 600,
    },
    confirmCommand: {
        backgroundColor: tokens.colorNeutralBackground2,
        ...shorthands.padding('12px'),
        ...shorthands.borderRadius('8px'),
        fontFamily: 'monospace',
        fontSize: '13px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    },
    confirmActions: {
        display: 'flex',
        justifyContent: 'flex-end',
        ...shorthands.gap('8px'),
    },
});

interface AIPanelProps {
    isOpen: boolean;
    onClose: () => void;
    fsContext?: FileSystemContext;
    className?: string;
    /** When set to a non-empty string, the chat input box is pre-filled with
     *  this value. Used by the "Ask Agent" flow to paste selected file paths
     *  so the user can type their intent before sending. */
    prefillInput?: string;
}

export const AIPanel = ({
    isOpen,
    onClose,
    fsContext,
    className,
    prefillInput,
}: AIPanelProps) => {
    const styles = useStyles();

    // Agent is the only mode. Kept as a const to avoid a wide rename of "mode" call sites.
    const mode = AIMode.Agent;
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isInitializing, setIsInitializing] = useState(true);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

    // Persistence + skills
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    // Mirror of activeConversationId for use inside async callbacks. persistMessage
    // is called twice per turn (user msg, then assistant msg after inference); both
    // calls live inside the same handleSendMessage closure, so without a ref the
    // assistant call would see a stale `null` and create a second conversation file.
    const activeConversationIdRef = useRef<string | null>(null);
    // Tracks the running summary attached to the active conversation. Read at
    // send time to prepend the summary, written after summarization completes.
    const summaryStateRef = useRef<SummaryState | null>(null);
    // Guards against running two summarizations concurrently for the same chat
    // (e.g. user spams messages while a summary call is still in flight).
    const summarizingRef = useRef(false);
    const setActiveConversation = useCallback((id: string | null) => {
        activeConversationIdRef.current = id;
        setActiveConversationId(id);
        if (id === null) {
            summaryStateRef.current = null;
        }
    }, []);
    const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
    const [historyVisible, setHistoryVisible] = useState(false);
    const [skills, setSkills] = useState<SkillManifest[]>([]);
    const skillsRef = useRef<SkillManifest[]>([]);
    skillsRef.current = skills;

    const [availableModels, setAvailableModels] = useState<ModelConfig[]>([]);
    const [selectedModelId, setSelectedModelId] = useState<string | undefined>();
    const [showSettings, setShowSettings] = useState(false);

    // Active provider - determines which models are shown in ModelSelector
    const [activeProvider, setActiveProvider] = useState<ModelProvider | undefined>();

    // Saved OpenAI-compatible presets. `presetsVersion` is bumped after any mutation
    // (settings dialog, header picker) so this component re-reads from storage.
    const [presetsVersion, setPresetsVersion] = useState<number>(0);
    void presetsVersion;
    const savedPresets: SavedOpenAIProvider[] = listSavedProviders();
    const [activePresetId, setActivePresetIdState] = useState<string | null>(null);

    // Download state
    const [downloadProgress, setDownloadProgress] = useState<{ status: string; progress: number; modelId: string } | undefined>(undefined);

    // Confirmation dialog (write = destructive mutation; read = privacy-sensitive content read)
    const [pendingConfirmation, setPendingConfirmation] = useState<{
        cmd: string;
        kind: 'write' | 'read';
        resolve: (value: boolean) => void;
    } | null>(null);
    const rejectConfirmRef = useRef<(() => void) | null>(null);

    const handleDownloadModel = async (modelId: string, provider: ModelProvider) => {
        if (provider !== ModelProvider.LlamaCpp) return;
        setDownloadProgress({ status: 'downloading', progress: 0, modelId });

        let unlisten: (() => void) | undefined;
        try {
            unlisten = await listen<{ modelId: string; status: string; progress: number }>(
                'llamacpp-download-progress',
                (event) => {
                    const { status, progress } = event.payload;
                    if (status === 'completed' || progress >= 1.0) {
                        setDownloadProgress(undefined);
                        // Refresh provider status to mark model as available
                        getProvidersStatus().then((statuses) => {
                            const allModels: ModelConfig[] = [];
                            statuses.forEach((s) => allModels.push(...s.availableModels));
                            setAvailableModels(allModels);
                        });
                    } else {
                        setDownloadProgress({ status, progress, modelId });
                    }
                }
            );
            await invoke('download_llamacpp_model', { modelId });
        } catch (error) {
            console.error('Download failed:', error);
            setDownloadProgress(undefined);
        } finally {
            if (unlisten) unlisten();
        }
    };

    // Initialize: Load available models
    useEffect(() => {
        async function initialize() {
            try {
                // Lift any legacy single-config localStorage into a "Default" preset.
                migrateLegacySingleConfig();

                // Load config first
                const config = loadAIConfig();

                // Log system recommendation for LlamaCpp
                invoke('get_llamacpp_recommendation').then((rec: any) => {
                    console.log('[AIPanel] System RAM:', rec.systemRamGb, 'GB');
                    console.log('[AIPanel] Recommended model:', rec.recommendedModelName);
                }).catch(() => {});

                const statuses = await getProvidersStatus();

                // Collect all available models
                const allModels: ModelConfig[] = [];
                statuses.forEach((status) => {
                    // Include models even if provider is "offline" (e.g. for "Known Models" library)
                    allModels.push(...status.availableModels);
                });

                setAvailableModels(allModels);

                // Check for saved defaults (localStorage overrides runtime config)
                const savedProvider = localStorage.getItem('defaultAIProvider_agent') as ModelProvider | null;
                const savedModelId = localStorage.getItem('defaultAIModel_agent');

                const defaultProvider = savedProvider || config.defaultProvider;

                // For OpenAI-compatible: prefer the active preset over flat-key fallback.
                const activePreset = defaultProvider === ModelProvider.OpenAICompatible
                    ? getActiveProvider()
                    : undefined;
                setActivePresetIdState(getActiveProviderId());

                const endpointKey = defaultProvider === ModelProvider.OpenAICompatible
                    ? 'defaultAIEndpoint_openaiCompatible'
                    : 'defaultAIEndpoint_ollama';
                const savedEndpoint = localStorage.getItem(endpointKey);
                const defaultEndpoint = activePreset?.endpoint || savedEndpoint || (
                    defaultProvider === ModelProvider.OpenAICompatible
                        ? config.endpoints.openaiCompatible
                        : config.endpoints.ollama
                );

                const configuredOpenAIModelId = activePreset?.modelName || config.defaultModels.openai;
                const defaultModelId = savedModelId || (defaultProvider === ModelProvider.OpenAICompatible ? configuredOpenAIModelId : null);

                // If we're using OpenAI-compatible provider, create the model
                if (defaultProvider === ModelProvider.OpenAICompatible && defaultEndpoint) {
                    // Check if model doesn't already exist
                    if (!allModels.find(m => m.id === configuredOpenAIModelId)) {
                        const genericModel: ModelConfig = {
                            id: configuredOpenAIModelId,
                            name: activePreset?.name
                                ? `${activePreset.name} (${configuredOpenAIModelId})`
                                : `OpenAI Compatible (${configuredOpenAIModelId})`,
                            provider: ModelProvider.OpenAICompatible,
                            modelId: configuredOpenAIModelId,
                            parameters: {
                                temperature: aiConfig.parameters.temperature,
                                topP: aiConfig.parameters.topP,
                                maxTokens: aiConfig.parameters.maxTokens,
                                stream: true
                            },
                            endpoint: defaultEndpoint,
                            apiKey: activePreset?.apiKey,
                            isAvailable: true,
                            recommendedFor: [AIMode.Agent],
                            sizeBytes: 0
                        };
                        allModels.push(genericModel);
                        setAvailableModels(allModels);
                    }
                }

                // Priority: 1) Saved model, 2) Env-configured model, 3) Provider's first available model, 4) Default model for mode
                let modelToSelect: ModelConfig | null = null;
                let providerToUse: ModelProvider | undefined = undefined;

                // Try to use saved model first
                if (savedModelId) {
                    modelToSelect = allModels.find(m => m.id === savedModelId) || null;
                    if (modelToSelect) {
                        providerToUse = modelToSelect.provider;
                    }
                }

                // If no saved model, try env-configured model
                if (!modelToSelect && defaultModelId) {
                    modelToSelect = allModels.find(m => m.id === defaultModelId) || null;
                    if (modelToSelect) {
                        providerToUse = modelToSelect.provider;
                    }
                }

                // If still no model, try saved/default provider's first available model
                if (!modelToSelect) {
                    modelToSelect = allModels.find(m =>
                        m.provider === defaultProvider && m.isAvailable
                    ) || allModels.find(m => m.provider === defaultProvider) || null;

                    if (modelToSelect) {
                        providerToUse = defaultProvider;
                    }
                }

                // Fallback to default model for mode
                if (!modelToSelect) {
                    modelToSelect = getDefaultModelForMode(mode, allModels);
                    if (modelToSelect) {
                        providerToUse = modelToSelect.provider;
                    }
                }

                // Apply the selected model and provider
                if (modelToSelect && providerToUse) {
                    setSelectedModelId(modelToSelect.id);
                    setActiveProvider(providerToUse);
                }
            } catch (error) {
                console.error('Failed to initialize AI panel:', error);
            } finally {
                setIsInitializing(false);
            }
        }

        initialize();
    }, []);

    // Update selected model when mode changes
    // BUT only if we don't already have a valid model selected
    useEffect(() => {
        // Check if current selection is still valid
        const currentModel = availableModels.find(m => m.id === selectedModelId);
        if (currentModel) {
            return; // Keep current selection
        }

        // No valid selection, choose a default for the mode
        const defaultModel = getDefaultModelForMode(mode, availableModels);
        if (defaultModel) {
            setSelectedModelId(defaultModel.id);
            // Update active provider when model changes
            setActiveProvider(defaultModel.provider);
        }
    }, [mode, availableModels, selectedModelId]);

    // Filter models based on active provider
    const filteredModels = React.useMemo(() => {
        if (!activeProvider) return availableModels;
        return availableModels.filter(m => m.provider === activeProvider);
    }, [availableModels, activeProvider]);

    // Get unique providers from available models
    const availableProviders = React.useMemo(() => {
        const providers = new Set(availableModels.map(m => m.provider));
        return Array.from(providers);
    }, [availableModels]);

    const handleUpdateConfig = (newConfig: ModelConfig) => {
        // Update the model config in available models list
        setAvailableModels(prev => prev.map(m => m.id === newConfig.id ? newConfig : m));
        // Also update local cache if needed, but for now just state is enough
    };

    const handleProviderChange = (newProvider: ModelProvider) => {
        setActiveProvider(newProvider);

        // Auto-select first available model from the new provider
        const firstModelOfProvider = availableModels.find(m =>
            m.provider === newProvider && m.isAvailable
        );

        if (firstModelOfProvider) {
            setSelectedModelId(firstModelOfProvider.id);
        } else {
            // If no available model, select the first one (even if not installed)
            const anyModelOfProvider = availableModels.find(m => m.provider === newProvider);
            if (anyModelOfProvider) {
                setSelectedModelId(anyModelOfProvider.id);
            }
        }
    };

    const handlePresetChange = (presetId: string) => {
        setActiveProviderId(presetId);
        setActivePresetIdState(presetId);
        setPresetsVersion((v) => v + 1);

        // Mirror the preset's model name into the selected synthetic OpenAI-compatible
        // ModelConfig so inference picks it up immediately.
        const preset = listSavedProviders().find((p) => p.id === presetId);
        if (preset) {
            setAvailableModels((prev) => {
                const others = prev.filter((m) => m.provider !== ModelProvider.OpenAICompatible);
                const synthetic: ModelConfig = {
                    id: preset.modelName,
                    name: `${preset.name} (${preset.modelName})`,
                    provider: ModelProvider.OpenAICompatible,
                    modelId: preset.modelName,
                    parameters: {
                        temperature: aiConfig.parameters.temperature,
                        topP: aiConfig.parameters.topP,
                        maxTokens: aiConfig.parameters.maxTokens,
                        stream: true,
                    },
                    endpoint: preset.endpoint,
                    apiKey: preset.apiKey,
                    isAvailable: true,
                    recommendedFor: [AIMode.Agent],
                    sizeBytes: 0,
                };
                return [...others, synthetic];
            });
            setSelectedModelId(preset.modelName);
        }
    };

    // Load skills on mount; refresh after settings dialog closes
    const refreshSkills = useCallback(async () => {
        try {
            const list = await listSkills();
            setSkills(list);
        } catch (e) {
            console.warn('[AIPanel] Failed to list skills:', e);
        }
    }, []);

    useEffect(() => {
        void refreshSkills();
    }, [refreshSkills]);

    useEffect(() => {
        if (!showSettings) {
            void refreshSkills();
        }
    }, [showSettings, refreshSkills]);

    // Phase 3: warm the user profile cache so the next inference call can
    // synchronously read it inside prepareMessages.
    useEffect(() => {
        if (!featureFlags.memoryUserProfile) return;
        void refreshUserProfileCache();
    }, []);



    const handleNewChat = useCallback(() => {
        setActiveConversation(null);
        setMessages([]);
    }, [setActiveConversation]);

    const handleSelectConversation = useCallback(async (id: string) => {
        try {
            const conv = await loadConversation(id);
            setActiveConversation(conv.id);
            setMessages(conv.messages.map(fromStoredMessage));
            summaryStateRef.current = conv.summary
                ? {
                    summary: conv.summary,
                    summaryThroughTimestamp: conv.summaryThroughTimestamp,
                    summaryUpdatedAt: conv.summaryUpdatedAt,
                }
                : null;
        } catch (e) {
            console.error('[AIPanel] Failed to load conversation:', e);
        }
    }, [setActiveConversation]);

    const persistMessage = useCallback(
        async (msg: ChatMessage, modelLabel?: string, providerLabel?: string, modeLabel?: string) => {
            try {
                const currentId = activeConversationIdRef.current;
                if (currentId) {
                    await persistAppendMessage(currentId, msg);
                    setHistoryRefreshKey((k) => k + 1);
                } else {
                    const conv = await createConversation(msg, {
                        model: modelLabel,
                        provider: providerLabel,
                        mode: modeLabel,
                    });
                    setActiveConversation(conv.id);
                    setHistoryRefreshKey((k) => k + 1);
                }
            } catch (e) {
                console.warn('[AIPanel] Persist failed:', e);
            }
        },
        [setActiveConversation]
    );

    const extractingFactsRef = useRef(false);

    const runBackgroundFactExtraction = useCallback(
        async (recentMessages: ChatMessage[], modelConfig: ModelConfig) => {
            if (extractingFactsRef.current) return;
            extractingFactsRef.current = true;
            try {
                const facts = await extractFactsFromConversation(recentMessages, modelConfig);
                if (facts.length === 0) return;
                await mergeUserProfileFacts(facts);
                console.log('[AIPanel] Merged profile facts', facts);
            } catch (e) {
                console.warn('[AIPanel] Fact extraction failed:', e);
            } finally {
                extractingFactsRef.current = false;
            }
        },
        [],
    );

    const runBackgroundSummarization = useCallback(
        async (
            fullHistory: ChatMessage[],
            modelConfig: ModelConfig,
            conversationId: string | null,
        ) => {
            if (!conversationId) return;
            if (summarizingRef.current) return;
            summarizingRef.current = true;
            try {
                const previous = summaryStateRef.current?.summary;
                const lastTimestamp = fullHistory[fullHistory.length - 1]?.timestamp ?? Date.now();
                const summary = await generateConversationSummary(
                    fullHistory,
                    modelConfig,
                    previous,
                );
                if (!summary) return;
                await updateConversationSummary(conversationId, summary, lastTimestamp);
                summaryStateRef.current = {
                    summary,
                    summaryThroughTimestamp: lastTimestamp,
                    summaryUpdatedAt: new Date().toISOString(),
                };
                console.log('[AIPanel] Updated conversation summary', {
                    conversationId,
                    throughTimestamp: lastTimestamp,
                    chars: summary.length,
                });
            } catch (e) {
                console.warn('[AIPanel] Summarization failed:', e);
            } finally {
                summarizingRef.current = false;
            }
        },
        [],
    );

    const handleStopGeneration = async () => {
        // Dismiss any pending confirmation dialog
        if (rejectConfirmRef.current) {
            rejectConfirmRef.current();
            rejectConfirmRef.current = null;
        }

        if (currentSessionId) {
            try {
                await invoke('cancel_inference', { sessionId: currentSessionId });

                // Remove any thinking/streaming messages
                setMessages((prev) => prev.filter(msg =>
                    !(msg.content === '💭 Thinking...' || msg.isStreaming)
                ));

                setIsLoading(false);
                setCurrentSessionId(null);
            } catch (error: any) {
                // If session not found, it likely already completed - this is not an error
                if (!error?.includes?.('not found')) {
                    console.error('Failed to cancel inference:', error);
                }

                // Remove any thinking/streaming messages even if cancel failed
                setMessages((prev) => prev.filter(msg =>
                    !(msg.content === '💭 Thinking...' || msg.isStreaming)
                ));

                // Always reset loading state even if cancel failed
                setIsLoading(false);
                setCurrentSessionId(null);
            }
        }
    };

    const handleSendMessage = async (content: string) => {
        // Clean up any incomplete messages and ensure proper alternation
        // IMPORTANT: We need to capture the cleaned messages to use for the API call
        let cleanedMessages: ChatMessage[] = [];

        setMessages((prev) => {
            // Remove streaming/thinking messages AND error messages from failed requests
            let cleaned = prev.filter(msg =>
                !(msg.content === '💭 Thinking...' ||
                    msg.isStreaming ||
                    msg.content.startsWith('Sorry, I encountered an error:') ||
                    msg.error)
            );

            // If last message is a user message, remove it (it was from a cancelled request)
            if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === MessageRole.User) {
                cleaned = cleaned.slice(0, -1);
            }

            cleanedMessages = cleaned; // Capture for API call
            return cleaned;
        });

        // Parse "/skill-name [args...]" — if it matches, we'll load the skill
        // body and inject it as a system message ahead of the user turn.
        const invocation = parseSkillInvocation(content, skillsRef.current);
        let skillSystemMessage: ChatMessage | null = null;
        let userVisibleContent = content;
        if (invocation) {
            try {
                const body = await loadSkillBody(invocation.name, invocation.args);
                skillSystemMessage = {
                    id: `skill-${invocation.name}-${Date.now()}`,
                    role: MessageRole.System,
                    content: `# Skill invoked: /${invocation.name}\n\n${body}`,
                    timestamp: Date.now(),
                };
                userVisibleContent = invocation.args
                    ? `/${invocation.name} ${invocation.args}`
                    : `/${invocation.name}`;
            } catch (err) {
                console.warn('[AIPanel] Failed to load skill body:', err);
            }
        }

        const userMessage = createMessage(MessageRole.User, userVisibleContent);
        setMessages((prev) => [...prev, userMessage]);
        setIsLoading(true);

        // Persist user message (fire-and-forget so we don't block the send)
        const selectedModelForPersist = availableModels.find((m) => m.id === selectedModelId);
        void persistMessage(
            userMessage,
            selectedModelForPersist?.modelId,
            selectedModelForPersist?.provider,
            mode
        );

        // Generate a unique session ID for this request
        const sessionId = `session-${Date.now()}`;
        setCurrentSessionId(sessionId);

        let downloadMsgId = '';
        let confirmCancelled = false;

        const toolExecutions: ToolExecutionData[] = [];

        try {
            const selectedModel = availableModels.find((m) => m.id === selectedModelId);

            // Enable streaming for all providers (Candle + Ollama)
            // Ideally we check if modelConfig.parameters.stream is true, but we know our backend implementations stream.
            const isStreaming = true;
            let assistantMsgId = `msg-${Date.now()}-ai`;

            // Create a "thinking" placeholder immediately for visual feedback
            let streamedContent = '';
            const thinkingMessage: ChatMessage = {
                id: assistantMsgId,
                role: MessageRole.Assistant,
                content: '💭 Thinking...',
                timestamp: Date.now(),
                isStreaming: true,
            };
            setMessages((prev) => [...prev, thinkingMessage]);

            // Add endpoint for OpenAI-compatible and Ollama providers
            // OpenAI-compatible reads from the active preset; Ollama still reads its flat key.
            let endpointToUse: string | undefined;
            let customModelName: string | undefined;
            let apiKey: string | undefined;
            if (activeProvider === ModelProvider.OpenAICompatible) {
                const preset = getActiveProvider();
                endpointToUse = preset?.endpoint
                    || localStorage.getItem('defaultAIEndpoint_openaiCompatible')
                    || selectedModel?.endpoint
                    || await getDefaultEndpoint(activeProvider);
                customModelName = preset?.modelName
                    || localStorage.getItem('customModelName_openaiCompatible')
                    || undefined;
                apiKey = preset?.apiKey
                    || localStorage.getItem('defaultAIKey_openaiCompatible')
                    || undefined;
            } else if (activeProvider === ModelProvider.Ollama) {
                endpointToUse = localStorage.getItem('defaultAIEndpoint_ollama')
                    || selectedModel?.endpoint
                    || await getDefaultEndpoint(activeProvider);

                if (selectedModel && selectedModel.provider !== activeProvider) {
                    console.warn(`[AIPanel] Provider mismatch detected! selectedModel.provider=${selectedModel.provider}, activeProvider=${activeProvider}. Using activeProvider for endpoint resolution.`);
                }
            }

            // Resolve effective contextWindow for OpenAI-compatible:
            //   1. explicit value on the saved preset (user typed it)
            //   2. auto-suggestion based on the model name (gpt-4o → 128K, etc.)
            //   3. fall through to the 8K default in computeMemoryBudget
            // For other providers, the value already lives on the ModelConfig.
            let presetContextWindow: number | undefined;
            if (activeProvider === ModelProvider.OpenAICompatible) {
                const preset = getActiveProvider();
                presetContextWindow =
                    preset?.contextWindow
                    ?? suggestContextWindow(customModelName || preset?.modelName)?.tokens;
            }

            const modelConfigWithEndpoint: ModelConfig = selectedModel
                ? {
                    ...selectedModel,
                    ...(endpointToUse ? { endpoint: endpointToUse } : {}),
                    // Use custom model name for OpenAI-compatible, fall back to gpt-4o
                    ...(activeProvider === ModelProvider.OpenAICompatible
                        ? { modelId: customModelName || 'gpt-4o' }
                        : {}),
                    // Pass API key for providers that require it
                    ...(apiKey ? { apiKey } : {}),
                    // Ensure provider is set correctly to prevent routing to wrong backend
                    provider: activeProvider || selectedModel.provider,
                    parameters: {
                        ...selectedModel.parameters,
                        ...(presetContextWindow ? { contextWindow: presetContextWindow } : {}),
                    },
                }
                : {
                    id: selectedModelId || 'custom',
                    name: selectedModelId || 'Custom Model',
                    provider: activeProvider || ModelProvider.OpenAICompatible,
                    modelId: customModelName || selectedModelId || 'gpt-4o',
                    parameters: {
                        temperature: 0.7,
                        topP: 0.9,
                        maxTokens: 4096,
                        stream: true,
                        ...(presetContextWindow ? { contextWindow: presetContextWindow } : {}),
                    },
                    isAvailable: true,
                    recommendedFor: [AIMode.Agent],
                    ...(endpointToUse ? { endpoint: endpointToUse } : {}),
                    ...(apiKey ? { apiKey } : {}),
                };

            console.log('[AIPanel] Selected model:', selectedModel?.id);
            console.log('[AIPanel] Selected model endpoint:', selectedModel?.endpoint);
            console.log('[AIPanel] endpointToUse:', endpointToUse);
            console.log('[AIPanel] customModelName:', customModelName);
            console.log('[AIPanel] Final modelConfigWithEndpoint.provider:', modelConfigWithEndpoint.provider);
            console.log('[AIPanel] Final modelConfigWithEndpoint.modelId:', modelConfigWithEndpoint.modelId);
            console.log('[AIPanel] Final modelConfigWithEndpoint.endpoint:', modelConfigWithEndpoint.endpoint);

            // Use the cleaned messages (not the stale 'messages' variable!)
            const baseMessages = skillSystemMessage
                ? [...cleanedMessages, skillSystemMessage, userMessage]
                : [...cleanedMessages, userMessage];
            const messagesToSend = featureFlags.memoryRunningSummary
                ? applySummaryToOutgoing(baseMessages, summaryStateRef.current)
                : baseMessages;

            const skillCatalog = formatSkillCatalog(skillsRef.current);

            // Shared onProgress callback for LlamaCpp download progress
            const onProgress = (progress: any) => {
                const { status, progress: pct } = progress;
                if (status === 'completed' || pct >= 1.0) {
                    if (downloadMsgId) {
                        setMessages((prev) => prev.filter(msg => msg.id !== downloadMsgId));
                        downloadMsgId = '';
                    }
                } else {
                    const pctDisplay = Math.round((pct || 0) * 100);
                    if (downloadMsgId) {
                        setMessages((prev) => prev.map(msg =>
                            msg.id === downloadMsgId
                                ? { ...msg, content: `Downloading model... ${pctDisplay}%` }
                                : msg
                        ));
                    } else {
                        const downloadId = `msg-${Date.now()}-download`;
                        downloadMsgId = downloadId;
                        const downloadMessage: ChatMessage = {
                            id: downloadId,
                            role: MessageRole.Assistant,
                            content: `Downloading model... ${pctDisplay}%`,
                            timestamp: Date.now(),
                            isStreaming: true,
                        };
                        setMessages((prev) => [...prev, downloadMessage]);
                    }
                }
            };

            const response = await runInferenceWithTools({
                sessionId: sessionId,
                modelConfig: modelConfigWithEndpoint,
                messages: messagesToSend,
                fsContext,
                mode,
                skillCatalog,
            }, {
                onChunk: isStreaming ? (chunk) => {
                    // Remove download message once we start getting chunks
                    if (downloadMsgId) {
                        setMessages((prev) => prev.filter(msg => msg.id !== downloadMsgId));
                        downloadMsgId = '';
                    }

                    if (streamedContent === '') {
                        streamedContent = chunk;
                        setMessages((prev) => prev.map(msg =>
                            msg.id === assistantMsgId
                                ? { ...msg, content: chunk, isStreaming: true }
                                : msg
                        ));
                        return;
                    }

                    streamedContent += chunk;
                    setMessages((prev) => prev.map(msg =>
                        msg.id === assistantMsgId
                            ? { ...msg, content: streamedContent, isStreaming: true }
                            : msg
                    ));
                } : undefined,
                onToolExecution: (event) => {
                    // Primary match: per-call id (model can invoke the same
                    // tool multiple times in a single turn).
                    // Fallback: oldest 'executing' row for the same toolName.
                    // Some models / fallback paths produce undefined ids; the
                    // fallback prevents the "stuck on Executing forever" bug
                    // even when id matching fails.
                    const findExisting = () => {
                        if (event.id) {
                            const byId = toolExecutions.find(e => e.id === event.id);
                            if (byId) return byId;
                        }
                        return toolExecutions.find(
                            e => e.toolName === event.toolName && e.status === 'executing',
                        );
                    };
                    if (event.cancelled) {
                        const existing = findExisting();
                        if (existing) {
                            existing.status = 'cancelled';
                            existing.result = event.result;
                        }
                    } else if (event.result || event.error) {
                        const existing = findExisting();
                        if (existing) {
                            existing.status = event.error ? 'error' as const : 'success' as const;
                            existing.result = event.result;
                            existing.error = event.error;
                            existing.executionTimeMs = event.executionTimeMs;
                            if (event.actions?.length) {
                                existing.actions = event.actions;
                            }
                        } else {
                            console.warn(
                                '[AIPanel] tool completion event had no matching executing row',
                                { id: event.id, toolName: event.toolName },
                            );
                        }
                    } else {
                        toolExecutions.push({
                            id: event.id,
                            toolName: event.toolName,
                            arguments: event.arguments as Record<string, unknown>,
                            status: 'executing',
                        });
                    }

                    setMessages((prev) => prev.map(msg =>
                        msg.id === assistantMsgId
                            ? { ...msg, toolExecutions: [...toolExecutions], isStreaming: true }
                            : msg
                    ));
                },
                isCancelled: () => confirmCancelled,
                onConfirmExecution: async (_toolName, args, kind) => {
                    const cmd = (args?.cmd as string) || '';
                    return new Promise<boolean>((resolve) => {
                        rejectConfirmRef.current = () => {
                            confirmCancelled = true;
                            resolve(false);
                            setPendingConfirmation(null);
                        };
                        setPendingConfirmation({ cmd, kind, resolve });
                    });
                },
                onProgress,
            });

            // Clean tool call tags from the response before displaying to user
            const cleanedContent = removeToolCallTags(response.message.content);
            const cleanedMessage = {
                ...response.message,
                content: cleanedContent || response.message.content, // Fallback to original if cleaning results in empty string
            };

            const finalAssistantMsg: ChatMessage = {
                ...cleanedMessage,
                toolExecutions: cleanedMessage.toolExecutions?.length
                    ? cleanedMessage.toolExecutions
                    : toolExecutions.length > 0 ? [...toolExecutions] : undefined,
                isStreaming: false,
            };

            if (isStreaming) {
                // Remove download message if still present
                if (downloadMsgId) {
                    setMessages((prev) => prev.filter(msg => msg.id !== downloadMsgId));
                }
                // Final update for streaming (ensure exact final state and remove streaming flag)
                setMessages((prev) => prev.map(msg =>
                    msg.id === assistantMsgId
                        ? finalAssistantMsg
                        : msg
                ));
            } else {
                // Non-streaming: Add the full message now
                setMessages((prev) => [...prev, finalAssistantMsg]);
            }

            void persistMessage(
                finalAssistantMsg,
                selectedModelForPersist?.modelId,
                selectedModelForPersist?.provider,
                mode
            );

            // Phase 2: kick off summarization in the background once the
            // conversation grows past the threshold. Fire-and-forget — the
            // user keeps chatting; the summary is consumed on the next turn.
            const fullHistory = [...cleanedMessages, userMessage, finalAssistantMsg];
            if (featureFlags.memoryRunningSummary) {
                const budget = computeMemoryBudget(
                    modelConfigWithEndpoint.parameters.contextWindow,
                    modelConfigWithEndpoint.parameters.maxTokens,
                );
                const decision = shouldSummarize(
                    fullHistory,
                    summaryStateRef.current?.summaryThroughTimestamp,
                    budget.summarizeThreshold,
                );
                if (decision.shouldSummarize && !summarizingRef.current) {
                    void runBackgroundSummarization(
                        fullHistory,
                        modelConfigWithEndpoint,
                        activeConversationIdRef.current,
                    );
                }
            }

            // Phase 3: extract durable facts about the user from this turn and
            // merge them into the profile. Only run on user-message-bearing
            // exchanges (skip pure tool-loop turns) and throttle by message count.
            if (
                featureFlags.memoryUserProfile &&
                fullHistory.length >= 4 &&
                fullHistory.length % 4 === 0
            ) {
                void runBackgroundFactExtraction(
                    fullHistory.slice(-8),
                    modelConfigWithEndpoint,
                );
            }
        } catch (error: any) {
            console.error('Inference failed:', error);

            // Remove download message if present
            if (downloadMsgId) {
                setMessages((prev) => prev.filter(msg => msg.id !== downloadMsgId));
            }

            // Don't show error message if the inference was cancelled by user
            const isCancelled = error.message?.includes('cancelled by user') ||
                error.message?.includes('Inference cancelled');

            if (isCancelled) {
                // Remove the "thinking" placeholder message if present
                setMessages((prev) => prev.filter(msg =>
                    !(msg.content === '💭 Thinking...' || msg.isStreaming)
                ));
            } else {
                const errorMessage = createMessage(
                    MessageRole.Assistant,
                    `Sorry, I encountered an error: ${error.message || 'Unknown error'}`
                );
                errorMessage.error = error.message;
                setMessages((prev) => [...prev, errorMessage]);
            }
        } finally {
            setIsLoading(false);
            setCurrentSessionId(null);
        }
    };

    const handleToolActionResponse = useCallback((actionId: string, response: 'confirm' | 'dismiss') => {
        const msg = response === 'confirm'
            ? `**Action Confirmed:** ${actionId}\nProceed with the operation as described.`
            : `**Action Rejected:** ${actionId}\nDo not proceed with this operation.`;
        handleSendMessage(msg);
    }, [handleSendMessage]);

    // Check if we are using a streaming provider
    const selectedModel = availableModels.find(m => m.id === selectedModelId);
    // All providers now stream
    const isStreamingProvider = true;

    if (isInitializing) {
        return (
            <div className={styles.container}>
                <div className={styles.loadingContainer}>
                    <Spinner size="large" />
                    <Text>Initializing AI...</Text>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <HistorySidebar
                visible={historyVisible}
                onClose={() => setHistoryVisible(false)}
                activeConversationId={activeConversationId}
                onSelect={handleSelectConversation}
                onNew={handleNewChat}
                refreshKey={historyRefreshKey}
            />
            <div className={styles.mainColumn}>
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    {!historyVisible && (
                        <Button
                            appearance="subtle"
                            icon={<PanelLeftExpand24Regular />}
                            size="small"
                            title="Show conversation history"
                            aria-label="Show conversation history"
                            onClick={() => setHistoryVisible(true)}
                        />
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
                        <Text weight="semibold" size={300}>RoRo</Text>
                        <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                            your self-service IT agent
                        </Text>
                    </div>
                </div>
                <div className={styles.headerRight}>
                    {featureFlags.headerPresetPicker && activeProvider === ModelProvider.OpenAICompatible && (
                        <ModelSelector
                            models={filteredModels}
                            selectedModelId={selectedModelId}
                            onModelChange={(modelId) => setSelectedModelId(modelId)}
                            activeProvider={activeProvider}
                            savedPresets={savedPresets}
                            activePresetId={activePresetId}
                            onPresetChange={handlePresetChange}
                        />
                    )}
                    <Button
                        appearance="subtle"
                        icon={<Settings24Regular />}
                        size="small"
                        title="Configure AI Provider & Model"
                        onClick={() => setShowSettings(!showSettings)}
                        style={{ color: tokens.colorNeutralForeground1 }}
                    />
                </div>
            </div>

            <div className={styles.chatContainer}>
                {availableModels.length === 0 ? (
                    <div className={styles.loadingContainer}>
                        <Text weight="semibold" size={400}>No AI models detected</Text>

                        {/* EMBEDDED MODEL DOWNLOAD OPTION */}
                        <div style={{
                            padding: '16px',
                            background: tokens.colorNeutralBackground2,
                            borderRadius: '8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '12px',
                            alignItems: 'center',
                            maxWidth: '90%',
                            border: `1px solid ${tokens.colorBrandStroke1}`
                        }}>
                            <Text weight="semibold">Get Started with Embedded AI</Text>
                            <Text align="center" size={200}>
                                Download the built-in AI engine (approx. 1GB) to enable smart features locally without extra setup.
                            </Text>

                            <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                                Download the Qwen 2.5 VL 3B model in Settings to get started.
                            </Text>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '80%' }}>
                            <div style={{ flex: 1, height: '1px', background: tokens.colorNeutralStroke1 }} />
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>OR USE OLLAMA</Text>
                            <div style={{ flex: 1, height: '1px', background: tokens.colorNeutralStroke1 }} />
                        </div>

                        <div style={{ textAlign: 'center', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
                            <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                                Advanced users can run larger models via Ollama.
                            </Text>
                        </div>

                        <Button
                            appearance="outline"
                            onClick={() => window.open('https://ollama.com', '_blank')}
                        >
                            Download Ollama
                        </Button>
                    </div>
                ) : (
                    <AIChat
                        messages={messages}
                        onSendMessage={handleSendMessage}
                        onStopGeneration={handleStopGeneration}
                        isLoading={isLoading}
                        isStreaming={isLoading && isStreamingProvider} // Only treat as streaming if loading AND provider matches
                        loadingStatus="Thinking..."
                        placeholder="Ask anything, or type / to invoke a skill"
                        skills={skills}
                        prefillInput={prefillInput}
                        onActionResponse={handleToolActionResponse}
                    />
                )}
            </div>

            {/* Settings Modal */}
            {selectedModelId && availableModels.find(m => m.id === selectedModelId) && (
                <AISettingsPanel
                    modelConfig={availableModels.find(m => m.id === selectedModelId)!}
                    allModels={availableModels}
                    activeProvider={activeProvider}
                    currentMode={mode}
                    onUpdateConfig={handleUpdateConfig}
                    onSelectModel={setSelectedModelId}
                    onProviderChange={handleProviderChange}
                    onClose={() => {
                        setShowSettings(false);
                        // Settings dialog may have mutated presets — re-read so the header
                        // ModelSelector reflects the latest list and active id.
                        setActivePresetIdState(getActiveProviderId());
                        setPresetsVersion((v) => v + 1);
                    }}
                    open={showSettings}
                    downloadProgress={downloadProgress}
                    onDownloadModel={handleDownloadModel}
                />
            )}

            {/* Confirmation dialog for write (destructive) or read (privacy-sensitive) commands */}
            {pendingConfirmation && (
                <div className={styles.confirmOverlay}>
                    <div className={styles.confirmDialog}>
                        <div className={styles.confirmTitle}>
                            {pendingConfirmation.kind === 'read'
                                ? 'Confirm file read'
                                : 'Confirm destructive command'}
                        </div>
                        <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                            {pendingConfirmation.kind === 'read'
                                ? 'The agent wants to read file contents into its context. Approve only if this file is safe to share with the model:'
                                : 'The agent wants to execute a potentially destructive command:'}
                        </Text>
                        <div className={styles.confirmCommand}>{pendingConfirmation.cmd}</div>
                        <div className={styles.confirmActions}>
                            <Button
                                appearance="secondary"
                                onClick={() => {
                                    pendingConfirmation.resolve(false);
                                    setPendingConfirmation(null);
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                appearance="primary"
                                onClick={() => {
                                    pendingConfirmation.resolve(true);
                                    setPendingConfirmation(null);
                                }}
                            >
                                Confirm
                            </Button>
                        </div>
                    </div>
                </div>
            )}
            </div>
        </div>
    );
}
