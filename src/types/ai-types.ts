/**
 * AI/LLM Type Definitions for RoRo
 * 
 * This file contains all TypeScript types and interfaces for the AI/LLM integration.
 */

/**
 * Supported AI model providers
 */
export enum ModelProvider {
    TransformerJS = 'transformerjs',
    Ollama = 'ollama',
    OpenAICompatible = 'openai-compatible',
    LlamaCpp = 'llamacpp',
    MLX = 'mlx',
}

/**
 * AI operation modes. Agent is the only mode — kept as a single-variant enum
 * so existing `mode` fields in stored conversations and the inference request
 * still serialize predictably.
 */
export enum AIMode {
    Agent = 'agent',
}

/**
 * Message role in a conversation
 */
export enum MessageRole {
    User = 'user',
    Assistant = 'assistant',
    System = 'system',
    Tool = 'tool',
}

/**
 * Model configuration
 */
export interface ModelConfig {
    /** Unique identifier for this configuration */
    id: string;
    /** Display name */
    name: string;
    /** Provider type */
    provider: ModelProvider;
    /** Model identifier (e.g., "llama3.2:3b" for Ollama) */
    modelId: string;
    /** Model parameters */
    parameters: ModelParameters;
    /** Custom endpoint (for OpenAI-compatible providers) */
    endpoint?: string;
    /** API key (optional, for local servers) */
    apiKey?: string;
    /** Whether this model is currently available/installed */
    isAvailable: boolean;
    /** Model size in bytes (if known) */
    sizeBytes?: number;
    /** Recommended use cases */
    recommendedFor: AIMode[];
}

/**
 * Model inference parameters
 */
export interface ModelParameters {
    /** Temperature (0.0 - 2.0) */
    temperature: number;
    /** Top-p sampling (0.0 - 1.0) */
    topP: number;
    /** Maximum tokens to generate */
    maxTokens: number;
    /** Whether to stream responses */
    stream: boolean;
    /** Stop sequences */
    stopSequences?: string[];
    /** Context window size */
    contextWindow?: number;
}

/**
 *  Tool result action — structured, machine-readable data the agent emits
 *  alongside human-readable text. The UI subscribes to these via the agent
 *  action bus and renders them as interactive elements (chips, navigation,
 *  native dialogs).
 */
export type ToolResultAction =
  | { type: 'navigate'; payload: { path: string } }
  | { type: 'render_tree'; payload: { root: string; totalSize: number; entries: Array<{ path: string; size: number; isDir: boolean }> } }
  | { type: 'open_file'; payload: { path: string } }
  | { type: 'highlight'; payload: { paths: string[]; reason?: string } }
  | { type: 'confirm_action'; payload: {
        title: string;
        description: string;
        items: string[];
        totalSize: number;
        severity: 'low' | 'medium' | 'high';
        actionId: string;
        /** The exact shell command the app will run if the user clicks
         *  Execute. Captured at emit time so we don't depend on the model
         *  re-issuing the same command after confirmation. */
        suggestedCommand: string;
        /** Absolute working directory for the suggested command. */
        suggestedWorkingDir: string;
    } }
  | { type: 'suggest_skill'; payload: {
        actionId: string;
        skill: string;
        title: string;
        description: string;
    } }
  | { type: 'browser_preview'; payload: {
        /** Tool name (browser_open / browser_navigate / browser_observe / browser_close). */
        kind: string;
        url?: string;
        title?: string;
        nodeCount?: number;
        hasScreenshot?: boolean;
        /** Base64 JPEG. Present on browser_observe in-flight; not persisted. */
        screenshot?: string;
        sessionId?: string;
        [extra: string]: unknown;
    } }
  | { type: 'workflow_card'; payload: {
        actionId: string;
        workflow: import('./workflow-types').WorkflowFileV2;
    } };

/**
 * Tool execution data for display
 */
export interface ToolExecutionData {
    /** Per-call id from the model. Used to match status updates back to the
     *  right row when the same tool runs multiple times in one turn. Optional
     *  because messages loaded from disk don't carry the original call id. */
    id?: string;
    toolName: string;
    arguments: Record<string, unknown>;
    result?: string;
    error?: string;
    executionTimeMs?: number;
    status: 'executing' | 'success' | 'error' | 'cancelled';
    /** Structured actions the agent emitted alongside text. The UI renders
     *  these as interactive chips, navigation targets, dialogs, etc. */
    actions?: ToolResultAction[];
}

/**
 * OpenAI-compatible tool definition
 */
export interface Tool {
    type: string; // "function"
    function: ToolFunction;
}

/**
 * Tool function definition
 */
export interface ToolFunction {
    name: string;
    description: string;
    parameters: Record<string, any>; // JSON Schema object
}

/**
 * Tool call in response (OpenAI format)
 */
export interface OpenAIToolCall {
    id: string;
    type: string; // "function"
    function: OpenAIToolCallFunction;
}

/**
 * Tool call function data (OpenAI format)
 */
export interface OpenAIToolCallFunction {
    name: string;
    arguments: string; // JSON string of arguments
}

/**
 * Chat message
 */
export interface ChatMessage {
    /** Unique message ID */
    id: string;
    /** Message role */
    role: MessageRole;
    /** Message content */
    content: string;
    /** Timestamp */
    timestamp: number;
    /** Associated file/folder paths (for context) */
    contextPaths?: string[];
    /** Whether this message is currently streaming */
    isStreaming?: boolean;
    /** Error message if inference failed */
    error?: string;
    /** Tool executions performed (for agent mode) */
    toolExecutions?: ToolExecutionData[];
    /** Tool calls in OpenAI format (for native function calling) */
    toolCalls?: OpenAIToolCall[];
    /** Base64-encoded JPEG screenshots attached to this message (browser-use
     *  vision payload). Wire-format only — not persisted to disk. The Rust
     *  OpenAI-compatible provider emits these as content[].image_url blocks
     *  when present; other providers drop them. */
    images?: string[];
    /** For Tool role messages: the tool_call_id this result corresponds to.
     *  Must match the id of the tool_call in the preceding assistant message. */
    toolCallId?: string;
}

/**
 * Chat session/conversation
 */
export interface ChatSession {
    /** Unique session ID */
    id: string;
    /** Session title (auto-generated or user-set) */
    title: string;
    /** Current AI mode */
    mode: AIMode;
    /** Model configuration used */
    modelConfig: ModelConfig;
    /** Messages in this session */
    messages: ChatMessage[];
    /** Created timestamp */
    createdAt: number;
    /** Last updated timestamp */
    updatedAt: number;
    /** Current file system context */
    fsContext?: FileSystemContext;
}

/**
 * File system context for AI operations
 */
export interface FileSystemContext {
    /** Current working directory */
    currentPath: string;
    /** Selected files/folders */
    selectedPaths: string[];
    /** Visible files in current view with metadata */
    visibleFiles?: FileMetadata[];
    /** Recent scan data (if available) */
    scanData?: ScanSummary;
}

/**
 * Metadata for a file or folder
 */
export interface FileMetadata {
    name: string;
    isDir: boolean;
    size: number;
    fileCount?: number;
    lastModified: number;
}

/**
 * Summary of file system scan data
 */
export interface ScanSummary {
    /** Total files scanned */
    totalFiles: number;
    /** Total size in bytes */
    totalSize: number;
    /** Largest files */
    largestFiles: Array<{
        path: string;
        size: number;
    }>;
    /** File type distribution */
    fileTypes: Record<string, number>;
    /** Scan timestamp */
    scannedAt: number;
}

/**
 * Inference request to backend
 */
export interface InferenceRequest {
    /** Session ID */
    sessionId: string;
    /** Model configuration */
    modelConfig: ModelConfig;
    /** Messages (conversation history) */
    messages: ChatMessage[];
    /** File system context */
    fsContext?: FileSystemContext;
    /** AI mode */
    mode: AIMode;
    /** Optional tools for native function calling (OpenAI format) */
    tools?: Tool[];
    /** Pre-formatted skill catalog injected into the {available_skills} prompt variable */
    skillCatalog?: string;
    /** Skip the agent system prompt + memory windowing. Used by internal calls
     *  like summarization that bring their own system message. */
    skipSystemPrompt?: boolean;
    /** Skip tool injection. Used by internal calls that should not have access
     *  to execute_command (summarization, fact extraction). */
    suppressTools?: boolean;
}

/**
 * Inference response from backend
 */
export interface InferenceResponse {
    /** Generated message */
    message: ChatMessage;
    /** Whether more chunks are coming (for streaming) */
    isComplete: boolean;
    /** Token usage statistics */
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    /** Inference time in milliseconds */
    inferenceTimeMs?: number;
}

/**
 * Model availability status
 */
export interface ModelAvailability {
    /** Model configuration */
    config: ModelConfig;
    /** Whether the model is installed/available */
    isAvailable: boolean;
    /** Download progress (0-1.0) if downloading */
    downloadProgress?: number;
    /** Current download status message */
    downloadStatus?: string;
    /** Error message if unavailable */
    error?: string;
}

/**
 * Provider status
 */
export interface ProviderStatus {
    /** Provider type */
    provider: ModelProvider;
    /** Whether the provider is available */
    isAvailable: boolean;
    /** Version information */
    version?: string;
    /** Available models */
    availableModels: ModelConfig[];
    /** Error message if unavailable */
    error?: string;
}

/**
 * AI settings/preferences
 */
export interface AISettings {
    /** Default model for each mode */
    defaultModels: Record<AIMode, string>; // model config IDs
    /** Whether AI features are enabled */
    enabled: boolean;
    /** Privacy settings */
    privacy: {
        /** Only allow local processing */
        localOnly: boolean;
        /** Disable telemetry */
        noTelemetry: boolean;
    };
    /** UI preferences */
    ui: {
        /** Whether AI panel is visible */
        panelVisible: boolean;
        /** Panel width (percentage) */
        panelWidth: number;
        /** Theme preference */
        theme: 'light' | 'dark' | 'auto';
    };
}

/**
 * Prompt template
 */
export interface PromptTemplate {
    /** Template ID */
    id: string;
    /** Template name */
    name: string;
    /** AI mode this template is for */
    mode: AIMode;
    /** System prompt template */
    systemPrompt: string;
    /** User prompt template */
    userPrompt: string;
    /** Variables that can be substituted */
    variables: string[];
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
    /** Unique ID for this tool call */
    id: string;
    /** Tool name to execute */
    name: string;
    /** Tool arguments (parsed from LLM response) */
    arguments: Record<string, unknown>;
}

/**
 * Result from executing a tool
 */
export interface ToolResult {
    /** ID of the tool call this is a result for */
    tool_call_id: string;
    /** Result content (can be text, JSON, etc.) */
    content: string;
    /** Whether this is an error result */
    isError: boolean;
    /** Execution time in milliseconds */
    executionTimeMs?: number;
}

/**
 * Error types for AI operations
 */
export enum AIErrorType {
    ModelNotFound = 'model_not_found',
    ProviderUnavailable = 'provider_unavailable',
    InferenceFailed = 'inference_failed',
    OutOfMemory = 'out_of_memory',
    NetworkError = 'network_error',
    InvalidConfiguration = 'invalid_configuration',
    ContextTooLarge = 'context_too_large',
}

/**
 * AI error
 */
export interface AIError {
    /** Error type */
    type: AIErrorType;
    /** Error message */
    message: string;
    /** Additional details */
    details?: Record<string, unknown>;
    /** Suggested actions */
    suggestedActions?: string[];
}

/**
 * Tool execution as stored on disk (matches Rust StoredToolExecution).
 */
export interface StoredToolExecution {
    toolName: string;
    arguments: Record<string, unknown> | unknown[] | null;
    result?: string;
    error?: string;
    status: string;
}

/**
 * Message as stored on disk (matches Rust StoredMessage).
 */
export interface StoredMessage {
    id: string;
    role: string;
    content: string;
    timestamp: number;
    toolExecutions?: StoredToolExecution[];
}

/**
 * Summary of a saved conversation (frontmatter-only view, used in history sidebar).
 */
export interface ConversationSummary {
    id: string;
    title: string;
    model?: string;
    provider?: string;
    mode?: string;
    created: string;
    updated: string;
    filePath: string;
    /** Running synthesis of the conversation; covers messages with timestamp <= summaryThroughTimestamp. */
    summary?: string;
    summaryThroughTimestamp?: number;
    summaryUpdatedAt?: string;
}

/**
 * Full conversation loaded from disk.
 */
export interface Conversation extends ConversationSummary {
    messages: StoredMessage[];
}

/**
 * A durable fact remembered about the user across conversations (Phase 3 memory).
 */
export interface ProfileFact {
    id: string;
    text: string;
    createdAt: string;
    lastReinforcedAt: string;
    reinforcementCount: number;
}

/**
 * The user profile — small set of durable facts injected into every conversation.
 */
export interface UserProfile {
    facts: ProfileFact[];
    lastUpdatedAt?: string;
}

/**
 * Hit returned by the cross-conversation search tool (Phase 4 memory).
 */
export interface ConversationSearchHit {
    id: string;
    title: string;
    updated: string;
    snippets: string[];
}

/**
 * Skill manifest (frontmatter + discovery state) returned by list_skills.
 */
export interface SkillManifest {
    name: string;
    description: string;
    whenToUse?: string;
    allowedTools: string[];
    disableModelInvocation: boolean;
    userInvocable: boolean;
    arguments: string[];
    argumentHint?: string;
    path: string;
    hasShellInjection: boolean;
    enabled: boolean;
    trusted: boolean;
    /** Capability strings declared in SKILL.md frontmatter. Recognized today:
     *  `browser:<url-glob>` (e.g. `browser:https://*.okta.com/*`) and
     *  `browser:screenshot`. Empty when the skill didn't declare any. */
    capabilities?: string[];
    /** "ephemeral" | "persistent" — browser profile preference declared
     *  by the skill. Used as the default profile in browser_open calls
     *  while this skill is active. */
    profile?: string;
}

/**
 * A saved OpenAI-compatible provider preset.
 * Bundles the endpoint, API key, and model name the user wants to reuse
 * so they can switch profiles (e.g., OpenRouter vs. local llama.cpp)
 * without retyping credentials.
 */
export interface SavedOpenAIProvider {
    id: string;
    name: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
    isDefault: boolean;
    createdAt: number;
    updatedAt: number;
    /** Provider-specific context window in tokens (drives the summarization
     *  threshold and history-trim budget). If omitted, the system falls back
     *  to a conservative default (8K). Auto-suggested from modelName in the UI. */
    contextWindow?: number;
    /** True when the active model accepts image content blocks (multimodal).
     *  Required for browser-use tools — without it the agent cannot see the
     *  screenshots browser_observe returns. Default false; user opts in per
     *  preset. Recommended models: Claude Sonnet 4.6 / Opus 4.7 via the
     *  OpenAI-compatible endpoint, GPT-4o / GPT-4.1, Qwen2.5-VL (local). */
    supportsVision?: boolean;
}
