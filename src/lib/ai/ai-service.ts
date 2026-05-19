/**
 * AI Service
 * 
 * Main service layer for AI/LLM operations.
 * Handles provider selection, inference routing, and state management.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    ModelConfig,
    ModelProvider,
    InferenceRequest,
    InferenceResponse,
    ProviderStatus,
    AIMode,
    ChatMessage,
    MessageRole,
    Tool,
} from '@/types/ai-types';
// Lazy import for TransformerJS to avoid SSR/build issues
// Import only when actually needed
const getTransformerJS = async () => {
    return await import('./providers/transformerjs');
};
import { buildFileSystemContext } from './context-builder';
import { getTemplateForMode, buildPrompt } from './prompts';
import { trimToTokenBudget, DEFAULT_WINDOW_CONFIG } from './memory/windowing';
import { trimScreenshotPayload } from './memory/screenshot-retention';
import { featureFlags } from '@/lib/featureFlags';
import { getCachedUserProfile, buildProfileSystemFragment } from './memory/profile-cache';
import { computeMemoryBudget } from './memory/budget';

// Native function calling tool definition for execute_command
const EXECUTE_COMMAND_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'execute_command',
        description: `Execute a shell command on the file system. Use this for ALL file operations: reading, writing, searching, listing, moving, and analyzing files and directories.

Use standard Unix commands: ls, cat, find, grep, du -sh, mv, cp, mkdir, rm, head, tail, wc, file, stat.

For reading files: cat <path>
For listing directories: ls -la <path>
For searching: find <dir> -name "*pattern*"
For directory sizes: du -sh <dir>/*`,
        parameters: {
            type: 'object',
            properties: {
                cmd: {
                    type: 'string',
                    description: 'The shell command to execute. Runs via sh -c "<cmd>". Use single quotes around paths to handle spaces.',
                },
                working_dir: {
                    type: 'string',
                    description: 'Working directory for the command (absolute path).',
                },
                timeout_secs: {
                    type: 'number',
                    description: 'Timeout in seconds (default: 30, max: 300).',
                },
            },
            required: ['cmd', 'working_dir'],
        },
    },
};

// Native function calling tool: emit structured UI actions (clickable paths,
// confirmation dialogs, file highlights). The agent calls this INSTEAD of
// describing paths in plain text — the UI renders these actions natively so
// the user can click, browse, and confirm visually.
const AGENT_ACTION_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'agent_action',
        description: `Emit a structured action that the app renders natively as clickable paths, confirmation dialogs, file highlights, or skill-suggestion cards.

Use this INSTEAD of writing file paths in plain text. The app shows chips, dialogs, and navigation — much better than text.

Examples:
• After du -sh, call agent_action with action="navigate" and paths=["/Users/name/Library/Caches"] to let the user click and browse
• Before any destructive command (rm/mv/dd/etc.), call agent_action with action="confirm_action", paths=[…], title="Delete 3 caches", description="These are safe to remove", totalSize=<bytes>, severity="medium", suggestedCommand="rm -rf '/path/a' '/path/b'", suggestedWorkingDir="/Users/name". The app will run suggestedCommand verbatim if the user clicks Execute — do NOT re-issue the command in a later turn.
• For files the user should inspect, call agent_action with action="open_file" and paths=["..."]
• After completing a multi-step browser task, call agent_action with action="suggest_skill", skill="workflow-creator", title="Save as Workflow", description="Turn what we just did into a reusable automation you can run with one click."

Constraints (enforced at dispatch):
- Paths must be absolute (start with "/" or a Windows drive letter); no embedded newlines or NULs; ≤ 4096 chars each.
- For confirm_action: title and description are required, plain text only, ≤ 500 chars each.
- For suggest_skill: skill, title, and description are required, plain text only, ≤ 200 chars each. No paths needed.
- severity defaults to "medium" when omitted; the app may escalate to "high" for system paths or very large operations regardless of what you claim.
- Max 5 actions per model response. Excess calls are rejected — batch into one confirm_action where possible.`,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['navigate', 'open_file', 'highlight', 'confirm_action', 'suggest_skill'],
                    description: 'What kind of UI action to emit.',
                },
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'One or more absolute file/directory paths. For navigate/open_file, the app uses the first path.',
                },
                title: {
                    type: 'string',
                    description: 'Title for the confirmation dialog (REQUIRED for confirm_action, max 500 chars, plain text).',
                },
                description: {
                    type: 'string',
                    description: 'Explanation shown in the dialog body (REQUIRED for confirm_action, max 500 chars, plain text).',
                },
                totalSize: {
                    type: 'number',
                    description: 'Total size in bytes of the items (for confirm_action display).',
                },
                severity: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'Risk level shown as a colored badge. Defaults to "medium" if omitted; auto-escalated to "high" for system paths or very large operations.',
                },
                suggestedCommand: {
                    type: 'string',
                    description: 'REQUIRED for confirm_action. The exact shell command the app will run if the user clicks Execute. Use single-quoted paths to handle spaces.',
                },
                suggestedWorkingDir: {
                    type: 'string',
                    description: 'REQUIRED for confirm_action. Absolute working directory for suggestedCommand.',
                },
                skill: {
                    type: 'string',
                    description: 'REQUIRED for suggest_skill. The skill name to invoke (e.g. "workflow-creator"), plain text, ≤ 200 chars.',
                },
            },
            required: ['action'],
        },
    },
};

// ─────────────────────────────────────────────────────────────────────────
// Browser-use tools (M1 — read-only set: open, navigate, observe, close).
// browser_act and browser_extract land in M2/M3.
//
// These are only registered when:
//   1. featureFlags.browserAgent is enabled, AND
//   2. The active model claims vision support (browser_observe returns
//      screenshots; without vision the model is blind).
//
// Risk classification + approval cards arrive with browser_act in M2; the
// read-only methods here are autonomous (no confirm prompts).
// ─────────────────────────────────────────────────────────────────────────

const BROWSER_OPEN_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'browser_open',
        description: `Open (or attach to) a browser session. Returns the session_id you'll pass to subsequent browser_* calls. Sessions persist until browser_close. Use a deterministic session_id ("main", "okta", "m365") so subsequent turns can reuse the same tab.

HEADED UPGRADE: If you call browser_open with headed=true on a session that is already open headlessly, the session is seamlessly promoted to a visible window — all cookies and current URL are preserved automatically. You do NOT need to close the session first. This is the correct way to handle mid-flow login detection.`,
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'Identifier for this browser session. Reuse the same id across calls to keep the same tab.',
                },
                profile: {
                    type: 'string',
                    enum: ['ephemeral', 'persistent'],
                    description: 'ephemeral (default): fresh profile, no cookies survive beyond this session. persistent: cookies and localStorage survive browser_close and are reloaded on the next browser_open with the same session_id — use this for SSO/login flows so the user only needs to authenticate once.',
                },
                viewport: {
                    type: 'object',
                    properties: {
                        width: { type: 'number' },
                        height: { type: 'number' },
                    },
                    description: 'Optional viewport size; defaults to 1280x800.',
                },
                headed: {
                    type: 'boolean',
                    description: 'false (default): headless, no visible window. true: open a visible Chromium window. Use headed=true whenever human interaction is needed: SSO login, password entry, CAPTCHA, MFA/2FA, or any page that blocks headless browsers ("JavaScript required"). Calling with headed=true on an existing headless session upgrades it in-place — cookies preserved.',
                },
            },
            required: ['session_id'],
        },
    },
};

const BROWSER_NAVIGATE_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'browser_navigate',
        description: `Navigate the session to a URL. Use absolute http(s):// URLs only. mailto:/tel:/file:/javascript: URLs are blocked. Returns { url, title } after the page settles.`,
        parameters: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                url: { type: 'string', description: 'Absolute URL starting with http:// or https://.' },
                wait_until: {
                    type: 'string',
                    enum: ['load', 'domcontentloaded', 'networkidle'],
                    description: 'When to consider navigation finished. Default: domcontentloaded.',
                },
            },
            required: ['session_id', 'url'],
        },
    },
};

const BROWSER_OBSERVE_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'browser_observe',
        description: `Capture the current page state: indexed accessibility tree + screenshot + url + title. This is the model's perception primitive — call it whenever you need to see the page. The ax tree is a flat list of interactive elements with role, name, and an index used by browser_act (M2).`,
        parameters: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                include_screenshot: {
                    type: 'boolean',
                    description: 'Whether to include a base64 JPEG screenshot. Default: true. Disable to save tokens when you only need the AX tree.',
                },
                max_elements: {
                    type: 'number',
                    description: 'Cap on number of AX nodes returned (default 80, max 200). Increase only when the page legitimately has many controls.',
                },
            },
            required: ['session_id'],
        },
    },
};

const BROWSER_CLOSE_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'browser_close',
        description: `Close the browser session and release Chromium resources. Always call this when you're done — otherwise the session lingers until the app exits.`,
        parameters: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
            },
            required: ['session_id'],
        },
    },
};

const BROWSER_ACT_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'browser_act',
        description: `Interact with an element from the most recent browser_observe. \`index\` references an entry in the ax array. The app classifies each call:
  - hover, scroll, plain typing into non-password fields, single clicks on non-form-submit elements → autonomous.
  - typing into password/credit-card inputs, clicking buttons inside a sensitive form, or setting submit=true → write (user approval prompt).
  - mailto:/tel:/file:/javascript: navigations are destructive (always approval).

The app shows the user a screenshot + intent before any write/destructive action and routes their Approve/Dismiss decision back. Cancelled actions return "Cancelled by user" — do not retry without addressing the user's reason.

For password fields, call browser_observe first so the app can detect password tags and route through approval correctly.`,
        parameters: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                action: {
                    type: 'string',
                    enum: ['click', 'type', 'select', 'scroll', 'press', 'hover'],
                    description: 'Interaction kind. scroll/press do not need an index. type/select use the text field for the value to type or option to select. press uses text as the key name (e.g. "Enter").',
                },
                index: {
                    type: 'number',
                    description: 'Index into the latest browser_observe ax[] array. Required for click/type/select/hover.',
                },
                text: {
                    type: 'string',
                    description: 'For type: text to type. For select: option value. For press: key name (e.g. "Enter", "Tab", "Escape"). For scroll: "up" | "down" | "top" | "bottom".',
                },
                submit: {
                    type: 'boolean',
                    description: 'When true, presses Enter after typing — used for "type and submit" patterns. Always classified as write.',
                },
            },
            required: ['session_id', 'action'],
        },
    },
};

const BROWSER_EXTRACT_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'browser_extract',
        description: `Extract structured data from the current page using a JSON-Schema-flavored selector map. Two shapes are supported:

1) Array of records — schema.type="array", schema["x-selector"] is the CSS row selector, schema.items.properties maps field names to per-field { "x-selector": <within-row CSS>, "x-attr"?: <attribute name> }. textContent if x-attr omitted.

2) Single record — schema.type="object", schema.properties maps field names the same way (selectors are relative to selector_hint or document).

Example (top 5 article titles + URLs from Wikipedia search):
{
  "type": "array",
  "x-selector": ".mw-search-result-heading",
  "items": {
    "type": "object",
    "properties": {
      "title": { "type": "string", "x-selector": "a" },
      "url":   { "type": "string", "x-selector": "a", "x-attr": "href" }
    }
  }
}

Returns { url, title, data, scope }. Array results capped at 200 rows.`,
        parameters: {
            type: 'object',
            properties: {
                session_id: { type: 'string' },
                schema: {
                    type: 'object',
                    description: 'JSON-Schema-flavored description of the data to extract (see tool description for x-selector/x-attr conventions).',
                },
                selector_hint: {
                    type: 'string',
                    description: 'Optional CSS selector to scope extraction. Defaults to "body".',
                },
            },
            required: ['session_id', 'schema'],
        },
    },
};

const RUN_WORKFLOW_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'run_workflow',
        description: `Launch a saved workflow by slug, binding variables from the conversation context.

Use when the user asks to perform a task that matches a known workflow (e.g. "create a Jira ticket", "reset their Okta password", "unlock account").

Step 1 — Identify available workflows:
  Call execute_command with cmd="ls ~/.ittoolkit/workflows/" to list workflow slugs.

Step 2 — Confirm with the user before starting:
  "I'll run the '{workflow name}' workflow with these values: {variable summary}. Should I proceed?"

Step 3 — Call run_workflow with the matching slug and variables inferred from conversation context.
  The workflow panel opens automatically and handles browser automation, retries, and human approval.

Step 4 — After the workflow completes, report the outcome to the user (e.g. "Ticket ITSUP-123 created").`,
        parameters: {
            type: 'object',
            properties: {
                slug: {
                    type: 'string',
                    description: 'Workflow slug (filename without .workflow.json). e.g. "jira-create-ticket".',
                },
                variables: {
                    type: 'object',
                    description: 'Key-value map of workflow variable values inferred from conversation context.',
                },
            },
            required: ['slug'],
        },
    },
};

const BROWSER_TOOLS: Tool[] = [
    BROWSER_OPEN_TOOL,
    BROWSER_NAVIGATE_TOOL,
    BROWSER_OBSERVE_TOOL,
    BROWSER_ACT_TOOL,
    BROWSER_EXTRACT_TOOL,
    BROWSER_CLOSE_TOOL,
    RUN_WORKFLOW_TOOL,
];

/**
 * Decide whether the active model has vision support. For OpenAI-compatible
 * presets we check the user-set supportsVision flag (defaults to false). For
 * LlamaCpp we infer from the model id (qwen2.5-vl / llava / vision …). All
 * other providers are non-vision in M1.
 */
function activeModelSupportsVision(modelConfig: ModelConfig): boolean {
    if (modelConfig.provider === ModelProvider.OpenAICompatible) {
        try {
            // Lazy import to avoid SSR issues (savedProviders touches localStorage).
            const { getActiveProvider } = require('./savedProviders') as {
                getActiveProvider: () => { supportsVision?: boolean } | undefined;
            };
            return !!getActiveProvider()?.supportsVision;
        } catch {
            return false;
        }
    }
    if (modelConfig.provider === ModelProvider.LlamaCpp) {
        const id = (modelConfig.modelId ?? '').toLowerCase();
        return /(vl|vision|llava|moondream)/.test(id);
    }
    return false;
}

export function canUseBrowserTools(modelConfig: ModelConfig): boolean {
    if (!featureFlags.browserAgent) return false;
    return activeModelSupportsVision(modelConfig);
}

// Web search tool (DuckDuckGo, no API key required).
// Available when browser tools are active so the agent can research unknown
// sites, find automation best practices, or look up documentation.
const WEB_SEARCH_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'web_search',
        description: `Search the web using DuckDuckGo. Use this to research automation techniques for unfamiliar websites, find Playwright/ARIA documentation, or look up best practices. Returns up to 5 results with title, snippet, and URL.

When automating a site with no <site-knowledge> block, call web_search("[site] playwright automation aria selectors") to learn the site's DOM patterns before attempting browser_act.

After succeeding with a new site, write your findings to ~/.ittoolkit/skills/browser-sites/{hostname}/SKILL.md via execute_command so the knowledge persists for future sessions.`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query. Be specific: e.g. "WhatsApp Web aria-label selectors playwright" not just "WhatsApp".',
                },
            },
            required: ['query'],
        },
    },
};

// Native function calling tool: search across the user's prior conversations.
// Use this when the user references something from a previous chat ("the script
// we wrote last week", "remember when…", "what did we decide about X").
const SEARCH_CONVERSATIONS_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'search_conversations',
        description: `Search the user's prior conversations for a keyword or phrase. Use ONLY when the user references past chats and the current conversation does not contain the answer. Returns up to 5 matching conversations with snippets.`,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Keyword or phrase to search for. Case-insensitive substring match.',
                },
                limit: {
                    type: 'number',
                    description: 'Max results (default 5, max 20).',
                },
            },
            required: ['query'],
        },
    },
};

// Native function calling tool: fetch the current workflow schema definition.
// Use this before creating or editing a workflow to get the latest available
// tools, actor types, variable sources, retry config, and postcondition types.
const GET_WORKFLOW_SCHEMA_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'get_workflow_schema',
        description: `Fetch the current workflow schema definition. Returns the latest available tools (browser.open, browser.navigate, browser.observe, browser.act, browser.extract, browser.close) with their params, actor types (auto/agent/human), variable sources (human_input/conversation_context/literal/step_output), retry configuration, and postcondition types. Use this before creating or editing any workflow to ensure valid JSON structure.`,
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
};

// Native function calling tool: execute a shell command on the local system.
const SHELL_EXEC_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'shell.exec',
        description: `Execute a shell command on the local system. Use for system administration, scripts, file operations, and queries. Returns stdout, stderr, and exit code.`,
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute.' },
                working_dir: { type: 'string', description: 'Working directory (absolute path). Defaults to home directory.' },
                timeout_secs: { type: 'number', description: 'Timeout in seconds (default 30, max 300).' },
            },
            required: ['command'],
        },
    },
};

// Native function calling tool: make an HTTP request to a REST API.
const HTTP_REQUEST_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'http.request',
        description: `Make an HTTP request to a REST API, webhook, or web service. Use for Jira API, Slack webhooks, M365 Graph API, etc. Returns status code and response body.`,
        parameters: {
            type: 'object',
            properties: {
                method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE.' },
                url: { type: 'string', description: 'Request URL (http:// or https:// only).' },
                headers: { type: 'object', description: 'HTTP headers as key-value pairs.' },
                body: { type: 'object', description: 'Request body as JSON object.' },
                timeout_secs: { type: 'number', description: 'Timeout in seconds (default 30).' },
            },
            required: ['method', 'url'],
        },
    },
};

// Native function calling tool: run another saved workflow by slug.
const WORKFLOW_RUN_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'workflow.run',
        description: `Run another saved workflow or activity by slug. Use for composing multi-step activities from reusable workflows. Launches the child workflow and returns confirmation.`,
        parameters: {
            type: 'object',
            properties: {
                slug: { type: 'string', description: 'Slug of the workflow/activity to run.' },
                variables: { type: 'object', description: 'Variable overrides for the child workflow.' },
            },
            required: ['slug'],
        },
    },
};

// Native function calling tool: pause for human interaction.
const HUMAN_GATE_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'human.gate',
        description: `Pause execution for human interaction. Use when the automation needs the user to review, confirm, or perform a physical-world action. The app shows a dialog; execution resumes when the user confirms.`,
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Instructions for the human — what to do or review.' },
                inputs: { type: 'array', description: 'Optional structured form fields: [{name, label, type, required}].' },
            },
            required: ['prompt'],
        },
    },
};

// Native function calling tool: delegate an open-ended task to the AI.
const AGENT_TASK_TOOL: Tool = {
    type: 'function',
    function: {
        name: 'agent.task',
        description: `Delegate an open-ended task to the AI agent. Use when the next step depends on reading, reasoning, or deciding based on previous results — e.g. "Parse the command output and extract device names". The agent returns its findings as a tool response.`,
        parameters: {
            type: 'object',
            properties: {
                instructions: { type: 'string', description: 'What the agent should do — plain language task description.' },
                context: { type: 'string', description: 'Optional context from previous steps or notes.' },
            },
            required: ['instructions'],
        },
    },
};

// Known models registry. `contextWindow` is the model's stated context window
// in tokens; the memory module uses it to size the summarization threshold and
// history trim budget.
export const KNOWN_MODELS: ModelConfig[] = [
    {
        id: 'llama3.2:1B', name: 'Llama 3.2 1B', provider: ModelProvider.Ollama, isAvailable: false,
        modelId: 'llama3.2:1B', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2048, stream: true, contextWindow: 131_072 },
        recommendedFor: [AIMode.Agent], sizeBytes: 1.3e9
    },
    {
        id: 'llama3.2:3B', name: 'Llama 3.2 3B', provider: ModelProvider.Ollama, isAvailable: false,
        modelId: 'llama3.2:3B', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2048, stream: true, contextWindow: 131_072 },
        recommendedFor: [AIMode.Agent], sizeBytes: 2.0e9
    },
    {
        id: 'mistral', name: 'Mistral 7B', provider: ModelProvider.Ollama, isAvailable: false,
        modelId: 'mistral', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 4096, stream: true, contextWindow: 32_768 },
        recommendedFor: [AIMode.Agent], sizeBytes: 4.1e9
    },
    {
        id: 'qwen2.5-coder:0.5b', name: 'Qwen 2.5 Coder 0.5B', provider: ModelProvider.Ollama, isAvailable: false,
        modelId: 'qwen2.5-coder:0.5b', parameters: { temperature: 0.2, topP: 0.7, maxTokens: 4096, stream: true, contextWindow: 32_768 },
        recommendedFor: [AIMode.Agent], sizeBytes: 0.35e9
    },
    {
        id: 'gemma:2b', name: 'Gemma 2B', provider: ModelProvider.Ollama, isAvailable: false,
        modelId: 'gemma:2b', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2048, stream: true, contextWindow: 8_192 },
        recommendedFor: [AIMode.Agent], sizeBytes: 1.5e9
    },
    // LlamaCpp (GGUF) - Local inference via bundled llama.cpp
    {
        id: 'llamacpp-coder05b', name: 'Qwen 2.5 Coder 0.5B (Q8_0)', provider: ModelProvider.LlamaCpp, isAvailable: false,
        modelId: 'qwen2.5-coder-0.5b-q8_0.gguf', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2048, stream: true, contextWindow: 32_768 },
        recommendedFor: [AIMode.Agent], sizeBytes: 495e6
    },
    {
        id: 'llamacpp-qwen3b', name: 'Qwen 2.5 VL 3B (Q4_K_M)', provider: ModelProvider.LlamaCpp, isAvailable: false,
        modelId: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 2048, stream: true, contextWindow: 32_768 },
        recommendedFor: [AIMode.Agent], sizeBytes: 2.0e9
    },
    {
        id: 'llamacpp-qwen7b', name: 'Qwen 2.5 7B Instruct (Q4_K_M)', provider: ModelProvider.LlamaCpp, isAvailable: false,
        modelId: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', parameters: { temperature: 0.4, topP: 0.9, maxTokens: 4096, stream: true, contextWindow: 32_768 },
        recommendedFor: [AIMode.Agent], sizeBytes: 4.68e9
    },
    // OpenAI-compatible - Generic entries for BYOK providers (OpenRouter, etc.).
    // contextWindow stays unset here so the saved preset's value drives it.
    {
        id: 'openai-compatible-generic', name: 'OpenAI Compatible (Custom)', provider: ModelProvider.OpenAICompatible, isAvailable: true,
        modelId: 'openai-compatible-generic', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 4096, stream: true },
        recommendedFor: [AIMode.Agent], sizeBytes: undefined
    },
    {
        id: 'unified-mode', name: 'Unified Mode (Auto-detect)', provider: ModelProvider.OpenAICompatible, isAvailable: true,
        modelId: 'unified-mode', parameters: { temperature: 0.7, topP: 0.9, maxTokens: 4096, stream: true },
        recommendedFor: [AIMode.Agent], sizeBytes: undefined
    }
];

/**
 * Get status of all AI providers
 */
export async function getProvidersStatus(): Promise<ProviderStatus[]> {
    try {
        // Get backend provider status (Ollama, etc.)
        // Pass Ollama endpoint from config
        const { loadAIConfig } = await import('./config');
        const config = loadAIConfig();

        console.log('[getProvidersStatus] Calling backend with ollamaEndpoint:', config.endpoints.ollama);
        const backendStatuses = await invoke<ProviderStatus[]>('get_ai_providers_status', {
            ollamaEndpoint: config.endpoints.ollama
        });
        console.log('[getProvidersStatus] Received backend statuses:', backendStatuses);

        // Merge backend/installed models with KNOWN_MODELS for Ollama
        // Robust check: Handle case sensitivity or missing status
        let ollamaStatus = backendStatuses.find(p => p.provider.toLowerCase() === ModelProvider.Ollama.toLowerCase());

        if (!ollamaStatus) {
            // If backend didn't return Ollama status (e.g. not running/found), create a placeholder
            // so we can still show the "Library" of known models for download guidance
            ollamaStatus = {
                provider: ModelProvider.Ollama,
                isAvailable: false,
                availableModels: [],
                version: undefined
            };
            backendStatuses.push(ollamaStatus);
        }

        if (ollamaStatus) {
            // Ensure availableModels exists (backend might return null or snake_case if misconfigured)
            if (!ollamaStatus.availableModels) {
                ollamaStatus.availableModels = [];
            }

            const installedIds = new Set(ollamaStatus.availableModels.map(m => m.modelId));

            // Add uninstalled KNOWN_MODELS with the correct endpoint
            KNOWN_MODELS.forEach(known => {
                if (known.provider === ModelProvider.Ollama && !installedIds.has(known.modelId)) {
                    const modelWithEndpoint = {
                        ...known,
                        endpoint: config.endpoints.ollama,
                        isAvailable: false // Mark as not available since not installed
                    };
                    console.log('[getProvidersStatus] Adding KNOWN_MODEL:', known.modelId, 'with endpoint:', modelWithEndpoint.endpoint);
                    ollamaStatus.availableModels.push(modelWithEndpoint);
                }
            });

            // Log all Ollama models with their endpoints
            console.log('[getProvidersStatus] Final Ollama models:',
                ollamaStatus.availableModels.map(m => ({
                    id: m.id,
                    modelId: m.modelId,
                    endpoint: m.endpoint,
                    isAvailable: m.isAvailable
                }))
            );
        }

        // Add TransformerJS status (browser-based) without loading the module
        // We define models statically to avoid loading the heavy TransformerJS library
        // until it's actually needed
        const transformerJSStatus: ProviderStatus = {
            provider: ModelProvider.TransformerJS,
            isAvailable: true,
            version: '2.17.2',
            availableModels: [
                {
                    id: 'transformerjs-distilbart',
                    name: 'DistilBART CNN (Small)',
                    provider: ModelProvider.TransformerJS,
                    modelId: 'Xenova/distilbart-cnn-6-6',
                    parameters: {
                        temperature: 0.7,
                        topP: 0.9,
                        maxTokens: 512,
                        stream: false,
                    },
                    isAvailable: true,
                    sizeBytes: 268_000_000,
                    recommendedFor: [AIMode.Agent],
                },
                {
                    id: 'transformerjs-bart-large',
                    name: 'BART Large CNN',
                    provider: ModelProvider.TransformerJS,
                    modelId: 'Xenova/bart-large-cnn',
                    parameters: {
                        temperature: 0.7,
                        topP: 0.9,
                        maxTokens: 1024,
                        stream: false,
                    },
                    isAvailable: true,
                    sizeBytes: 1_630_000_000,
                    recommendedFor: [AIMode.Agent],
                },
            ],
        };

        // Add OpenAI-Compatible KNOWN_MODELS so they appear in availableModels
        // (needed for provider switching to find models to select)
        const openAICompatibleStatus: ProviderStatus = {
            provider: ModelProvider.OpenAICompatible,
            isAvailable: true,
            version: undefined,
            availableModels: KNOWN_MODELS.filter(m => m.provider === ModelProvider.OpenAICompatible).map(m => ({
                ...m,
                endpoint: config.endpoints.openaiCompatible,
            })),
        };

        // Add LlamaCpp KNOWN_MODELS for the model library (installed models come from backend)
        const llamacppStatus = backendStatuses.find(p => p.provider.toLowerCase() === ModelProvider.LlamaCpp.toLowerCase());
        if (llamacppStatus) {
            const installedLcIds = new Set(llamacppStatus.availableModels.map(m => m.modelId));
            KNOWN_MODELS.forEach(known => {
                if (known.provider === ModelProvider.LlamaCpp && !installedLcIds.has(known.modelId)) {
                    llamacppStatus.availableModels.push(known);
                }
            });
        }

        return [transformerJSStatus, openAICompatibleStatus, ...backendStatuses];
    } catch (error) {
        console.error('Failed to get provider status:', error);
        return [];
    }
}

/**
 * Get available models for a provider
 */
export async function getProviderModels(
    provider: ModelProvider,
    endpoint?: string
): Promise<ModelConfig[]> {
    if (provider === ModelProvider.TransformerJS) {
        const transformerJS = await getTransformerJS();
        return transformerJS.getAvailableTransformerJSModels();
    }

    try {
        return await invoke<ModelConfig[]>('get_provider_models', {
            provider: provider.toString(),
            endpoint,
        });
    } catch (error) {
        console.error(`Failed to get models for ${provider}:`, error);
        return [];
    }
}

/**
 * Check if a provider is available
 */
export async function checkProviderAvailability(
    provider: ModelProvider,
    endpoint?: string
): Promise<boolean> {
    if (provider === ModelProvider.TransformerJS) {
        const transformerJS = await getTransformerJS();
        return await transformerJS.isTransformerJSAvailable();
    }

    try {
        return await invoke<boolean>('check_provider_availability', {
            provider: provider.toString(),
            endpoint,
        });
    } catch (error) {
        console.error(`Failed to check availability for ${provider}:`, error);
        return false;
    }
}

/**
 * Cancel an ongoing inference request
 */
export async function cancelInference(sessionId: string): Promise<void> {
    try {
        await invoke('cancel_inference', { sessionId });
        console.log('[ai-service] Cancelled inference for session:', sessionId);
    } catch (error) {
        console.error('[ai-service] Failed to cancel inference:', error);
        throw error;
    }
}

/**
 * Run AI inference
 */
export async function runInference(
    request: InferenceRequest,
    onChunk?: (chunk: string) => void,
    onProgress?: (progress: any) => void
): Promise<InferenceResponse> {
    // Add system prompt based on mode
    const messagesWithSystem = prepareMessages(request);
    let requestWithSystem = { ...request, messages: messagesWithSystem };

    // Add native function calling tool for providers that support it
    // (LlamaCpp + OpenAI-compatible). More reliable than XML tool calling.
    if (
        !request.suppressTools &&
        [ModelProvider.LlamaCpp, ModelProvider.OpenAICompatible].includes(request.modelConfig.provider)
    ) {
        const tools: Tool[] = [
            EXECUTE_COMMAND_TOOL, AGENT_ACTION_TOOL, GET_WORKFLOW_SCHEMA_TOOL,
            SHELL_EXEC_TOOL, HTTP_REQUEST_TOOL, WORKFLOW_RUN_TOOL, HUMAN_GATE_TOOL, AGENT_TASK_TOOL,
        ];
        if (featureFlags.memoryCrossConversationSearch) {
            tools.push(SEARCH_CONVERSATIONS_TOOL);
        }
        if (canUseBrowserTools(request.modelConfig)) {
            tools.push(...BROWSER_TOOLS);
            tools.push(WEB_SEARCH_TOOL);
        }
        requestWithSystem = {
            ...requestWithSystem,
            tools,
        };
    }

    // Route to appropriate provider
    if (request.modelConfig.provider === ModelProvider.TransformerJS) {
        const transformerJS = await getTransformerJS();
        return await transformerJS.runTransformerJSInference(requestWithSystem, onChunk, onProgress);
    }

    // For backend providers (Ollama, OpenAI-compatible, LlamaCpp)
    try {
        let unlistenChunk: (() => void) | undefined;
        let unlistenProgress: (() => void) | undefined;

        // Setup streaming listener if onChunk callback is provided
        if (onChunk) {
            unlistenChunk = await listen<string>('ai-response-chunk', (event) => {
                onChunk(event.payload);
            });
        }

        // Setup LlamaCpp download progress listener
        if (onProgress && request.modelConfig.provider === ModelProvider.LlamaCpp) {
            unlistenProgress = await listen<any>('llamacpp-download-progress', (event) => {
                onProgress(event.payload);
            });
        }

        const response = await invoke<InferenceResponse>('run_ai_inference', {
            request: requestWithSystem,
        });

        if (unlistenChunk) unlistenChunk();
        if (unlistenProgress) unlistenProgress();
        return response;
    } catch (error: any) {
        console.error('[ai-service] Inference failed:', error);
        throw new Error(error || 'Inference failed');
    }
}

/**
 * Prepare messages with system prompt
 */
function prepareMessages(request: InferenceRequest): ChatMessage[] {
    const budget = computeMemoryBudget(
        request.modelConfig.parameters.contextWindow,
        request.modelConfig.parameters.maxTokens,
    );
    const windowBudget = budget.historyBudget || DEFAULT_WINDOW_CONFIG.budgetTokens;

    if (request.skipSystemPrompt) {
        const withScreenshotCap = trimScreenshotPayload(request.messages, 3).messages;
        if (featureFlags.memorySlidingWindow) {
            const trimmed = trimToTokenBudget(withScreenshotCap, windowBudget);
            return trimmed.messages;
        }
        return withScreenshotCap;
    }
    try {
        const template = getTemplateForMode(request.mode);

        // Build context string
        const fsContextStr = request.fsContext
            ? buildFileSystemContext(request.fsContext)
            : 'No file system context available.';

    const executeCommandDesc = `## Two tools, two jobs

Think of \`agent_action\` and \`execute_command\` as a pair:
- Use **\`execute_command\`** to *gather* information from the file system (sizes, listings, contents).
- Use **\`agent_action\`** to *present* paths the user can click and to *propose* destructive operations as inline cards. Plain markdown paths are dead text; the user cannot click them.

If your reply mentions a path, you owe an \`agent_action\` for it. If you are proposing a delete / move / overwrite, you owe an \`agent_action(confirm_action)\` with a complete \`suggestedCommand\` — never ask "should I delete X?" in chat.

## agent_action Tool

Emit a structured action the app renders natively (clickable chips, confirmation cards, navigation, file highlights). The app gates user safety; you focus on intent.

Tool: agent_action
Arguments:
  - action (string, REQUIRED): one of "navigate", "open_file", "highlight", "confirm_action", "workflow_card".
  - paths (array of strings, REQUIRED): one or more absolute paths (POSIX "/…" or Windows "C:\\…"). For navigate/open_file the app uses paths[0].
  - title (string, REQUIRED for confirm_action): plain text, ≤ 500 chars.
  - description (string, REQUIRED for confirm_action): plain text body, ≤ 500 chars.
  - suggestedCommand (string, REQUIRED for confirm_action): the EXACT shell command the app will run verbatim if the user clicks Execute. Use single-quoted paths to handle spaces.
  - suggestedWorkingDir (string, REQUIRED for confirm_action): absolute working directory for suggestedCommand.
  - totalSize (number, optional): total bytes; used for the card display.

### workflow_card
Emit a structured workflow preview card the user can accept, edit, or dismiss. Use this AFTER designing the complete workflow — the card lets the user review, test individual steps, and save with one click.
Arguments:
  - workflow (object, REQUIRED): full WorkflowFileV2 object with name, slug, description, goal, variables, and steps.

Example — after designing a workflow for resetting Okta passwords:
  agent_action {
    "action": "workflow_card",
    "workflow": {
      "version": 2,
      "name": "Reset Okta Password",
      "slug": "reset-okta-password",
      "description": "Reset a user's Okta password via the admin console",
      "goal": "User notified that their password has been reset and they can log in with the temporary password",
      "createdAt": "2026-01-01T00:00:00Z",
      "variables": [{"name":"user_email","type":"string","source":"conversation_context","description":"Email of the user to reset","defaultValue":""}],
      "steps": [
        {"id":"step-open","intent":"Open Okta admin session","tool":"browser.open","params":{"session_id":"okta","profile":"persistent"},"actor":"auto","classification":"read","retry":{"maxAuto":2,"escalateTo":"human"}},
        {"id":"step-navigate","intent":"Navigate to Okta admin users","tool":"browser.navigate","params":{"session_id":"okta","url":"https://{{okta_domain}}/admin/users"},"actor":"auto","classification":"read","retry":{"maxAuto":2,"escalateTo":"human"}}
      ]
    }
  }
  - severity (string, optional): "low" | "medium" | "high". Defaults to "medium" if omitted. The app auto-escalates to "high" for system paths (/System, /usr, /Library, C:\\Windows, …) or operations over 10 GiB / 50 paths regardless of what you claim.

Hard limits enforced at dispatch (the call fails if you exceed them):
- ≤ 5 agent_action calls per model response. Batch related paths into one confirm_action where possible.
- Paths must be absolute, free of newlines / NUL bytes, ≤ 4096 chars.
- suggestedCommand must not contain embedded newlines.

Example — after \`du -sh ~/Library ~/Documents\`:
  agent_action {"action":"navigate","paths":["/Users/you/Library"]}
  agent_action {"action":"navigate","paths":["/Users/you/Documents"]}

Example — proposing a cache cleanup (do this INSTEAD of asking in text):
  agent_action {
    "action":"confirm_action",
    "paths":["/Users/you/Library/Caches"],
    "title":"Clear app caches",
    "description":"Removes contents of ~/Library/Caches. Apps regenerate caches; no user data lost.",
    "suggestedCommand":"rm -rf '/Users/you/Library/Caches'/*",
    "suggestedWorkingDir":"/",
    "severity":"medium",
    "totalSize":271390000
  }

## execute_command Tool

Run shell commands to gather information. After any command returns paths the user might care about, follow up with one or more agent_action calls.

Tool: execute_command
Description: Execute a shell command on the file system. Use this for ALL file operations including reading, writing, searching, listing, moving, and analyzing files and directories.
Arguments:
  - cmd (string, required): The shell command to execute. Runs via \`sh -c "<cmd>"\`.
  - working_dir (string, required): Working directory for the command (absolute path).
  - timeout_secs (number, optional): Timeout in seconds (default: 30, max: 300).

Returns: { stdout: string, stderr: string, exit_code: number, timed_out: boolean }

IMPORTANT USAGE RULES:
- ALWAYS use this tool for ALL file operations. NEVER guess or hallucinate file contents.
- Use standard Unix commands: \`ls\`, \`cat\`, \`find\`, \`grep\`, \`du\`, \`mv\`, \`cp\`, \`mkdir\`, \`rm\`, \`head\`, \`tail\`, \`wc\`, \`md5sum\`, \`file\`, \`stat\`
- For reading files: \`cat <path>\` or \`head -n 100 <path>\` — these prompt the user for permission before running.
- For listing directories: \`ls -la <path>\`
- For searching: \`find <dir> -name "*pattern*"\` or \`grep -r "pattern" <dir>\`
- For directory sizes: \`du -sh <dir>/*\`
- Output is capped at ~10K characters. For large outputs, use \`head\`/\`tail\` to limit.
- The command runs in the specified working directory.
- Default timeout is 30 seconds. Use timeout_secs for long-running operations.
- Security-blocked commands include: destructive system operations, privilege escalation, shutdown commands.
- File-reading commands (cat/less/more/head/tail/bat/od/xxd/strings) and write/move commands (rm/mv/cp/dd, shell redirects) prompt the user for explicit approval before executing.
- For destructive operations the preferred path is NOT direct \`execute_command\` — emit an \`agent_action(confirm_action)\` instead so the user sees an inline card.

${featureFlags.memoryCrossConversationSearch ? `## search_conversations Tool

Search the user's prior conversations for a keyword. Use ONLY when the user references past chats and the current context doesn't contain the answer.

Tool: search_conversations
Arguments:
  - query (string, required): Substring to search for (case-insensitive).
  - limit (number, optional): Max results, default 5, max 20.

Returns: Array of {id, title, updated, snippets[]} for matching conversations.

Do NOT call this for things you can answer from the current conversation or current file system. Calling unnecessarily wastes tokens.` : ''}

${canUseBrowserTools(request.modelConfig) ? `## Browser tools

The agent can drive a real Chromium browser via five tools. Use them for web-based IT tasks (admin consoles, status pages, knowledge base lookups).

Risk tiers (mirror the shell classifier):
- READ — autonomous: open, close, observe, http(s) navigation, hover/scroll, plain typing into non-password fields, single clicks on non-form-submit elements.
- WRITE — user-approval required: typing into a password/credit-card field, clicking a button inside a form that contains password/credit-card inputs, anything with submit=true.
- DESTRUCTIVE — user-approval required, hard-default risky: mailto:/tel:/file:/javascript: navigation.

You will receive "Cancelled by user" if the user denies an action. Do not retry the same action — ask the user what to do instead.

### browser_open
Opens a session (or attaches to an existing one). Always call this first.
Arguments: session_id (string, required), profile ("ephemeral" | "persistent", optional), viewport (optional).
Returns: { session_id }.

### browser_navigate
Loads a URL in the session. Use absolute http(s):// URLs.
Arguments: session_id (required), url (required), wait_until ("load" | "domcontentloaded" | "networkidle", optional).
Returns: { url, title }.

### browser_observe
Captures page state as { url, title, ax, screenshot }. The ax field is a flat indexed list of interactive elements: [{ index, role, name, value?, leaf, tags? }]. tags may include "password" (typing here is write) and "form_submit" (clicking here is write).
Arguments: session_id (required), include_screenshot (boolean, default true), max_elements (number, default 80, max 200).

### browser_act
Interact with an element from the latest browser_observe (referenced by index).
Arguments: session_id (required), action ("click" | "type" | "select" | "scroll" | "press" | "hover", required), index (for click/type/select/hover), text (for type/select/press/scroll), submit (boolean, defaults false).

### browser_close
Releases the Chromium resources. Always call this when finished with a session.
Arguments: session_id (required).

### shell.exec
Execute a shell command on the local system. Use for system administration, scripts, file operations, queries.
Arguments: command (string, required), working_dir (string, optional, defaults to home), timeout_secs (number, optional, default 30).
Returns: { stdout, stderr, exit_code }.
Security: read/write classification applies via the same gate as execute_command.

### http.request
Make an HTTP request to a REST API, webhook, or web service. Use for Jira API, Slack webhooks, M365 Graph API, etc.
Arguments: method (string, required: GET/POST/PUT/PATCH/DELETE), url (string, required), headers (object, optional), body (object, optional for write methods), timeout_secs (number, optional, default 30).
Returns: { status, statusText, body }.
Security: URLs starting with http:// or https:// only.

### workflow.run
Run another saved workflow or activity by slug. Use for composing multi-step activities from reusable workflows.
Arguments: slug (string, required), variables (object, optional — overrides for the child workflow).
Returns: confirmation that the child workflow has been launched.

### human.gate
Pause execution for human interaction. Use when the automation needs the user to review, confirm, or perform a physical-world action.
Arguments: prompt (string, required — what the human should do), inputs (array, optional — structured form fields [{name, label, type, required}]).
The app shows a dialog; execution resumes when the user confirms.

### agent.task
Delegate an open-ended task to the AI agent. Use when the next step depends on reading, reasoning, or deciding based on previous results — e.g. "Parse the command output and extract device names".
Arguments: instructions (string, required — what to do), context (string, optional — prior step output or notes).
The agent returns the result as a tool response.

USAGE PATTERN:
  1. browser_open {"session_id":"main"}
  2. browser_navigate {"session_id":"main","url":"https://…"}
  3. browser_observe {"session_id":"main"}    // see the page; note element indices and tags
  4. browser_act {"session_id":"main","action":"type","index":7,"text":"…"}
  5. browser_observe {"session_id":"main"}    // confirm the change
  6. browser_close {"session_id":"main"}      // when done

### run_workflow
Launch a saved workflow (recorded automation sequence) by slug with pre-filled variables.
Arguments: slug (string, required), variables (object, optional — variable values from conversation context).
Returns: confirmation that the workflow panel has been opened.

Use to run IT tasks like "create a Jira ticket", "unlock Okta account", "reset M365 password" when a matching workflow exists.
List available workflows first: execute_command { cmd: "ls ~/.ittoolkit/workflows/", working_dir: "/" }

### get_workflow_schema
Fetch the current workflow schema definition. Use this BEFORE creating or editing a workflow to get the latest available tools, actor types, variable sources, retry configuration, and postcondition types.
No arguments required. Returns a JSON schema object.

### Human-interaction detection — automatic headed upgrade

Detect these signals from browser_observe results and IMMEDIATELY switch to headed mode:
- URL contains: /login, /signin, /sso, /auth, /saml, /oauth, adfs., okta., microsoftonline.com, ping., onelogin.
- AX tree shows a password textbox (tags includes "password")
- Page title or heading contains: "sign in", "log in", "javascript required", "authenticate", "captcha"
- Page content indicates bot/automation detection ("JavaScript is required", "browser not supported")

When ANY of these signals are detected, take these steps IN ORDER — do not skip any:
1. FIRST — call browser_open with the SAME session_id, headed=true, and profile="persistent". This upgrades the session in-place; cookies and the current URL are preserved automatically. Do NOT write any message to the user before this tool call completes.
2. THEN — tell the user exactly: "I've opened a browser window for you to complete the login/verification. Please sign in and then tell me to continue."
3. STOP — do not call any more browser tools. Wait for the user to explicitly say they have completed the interaction before proceeding.

Do NOT try to type passwords or click submit on login forms. Do NOT loop calling browser_observe to poll for completion. Wait for the user.

### Workflow creation offer
After successfully completing a multi-step browser task (you navigated, filled fields, submitted, and got a result), call agent_action with action="suggest_skill", skill="workflow-creator", title="Save as Workflow", description="Turn what we just did into a reusable automation you can run with one click."
Do NOT offer this in plain text — emit the card. Only once per completed task, not after every individual step.` : ''}`;

    let systemPrompt = buildPrompt(template.systemPrompt, {
        fs_context: fsContextStr,
        current_path: request.fsContext?.currentPath || '/',
        mcp_tools: executeCommandDesc,
        available_skills: request.skillCatalog || '(no skills installed)',
    });

    if (featureFlags.memoryUserProfile) {
        const profile = getCachedUserProfile();
        const fragment = buildProfileSystemFragment(profile);
        if (fragment) systemPrompt = `${systemPrompt}\n\n${fragment}`;
    }

    console.log('[ai-service] System prompt built:');
    console.log('[ai-service]   Mode:', request.mode);
    console.log('[ai-service]   System prompt length:', systemPrompt.length);
    console.log('[ai-service]   System prompt preview (first 500 chars):', systemPrompt.substring(0, 500));
    console.log('[ai-service]   Execute command tool description length:', executeCommandDesc.length);

    // Find an existing AGENT system message (id starts with "system-agent-")
    // and refresh it in place. We intentionally do NOT touch other system
    // messages in the array — those carry conversation-summary text (id
    // "summary-…") or invoked-skill bodies (id "skill-…") that must survive
    // the round-trip to the model. The previous unconditional replace was
    // silently overwriting summaries.
    const agentSystemIndex = request.messages.findIndex(
        (m) => m.role === MessageRole.System && m.id.startsWith('system-agent-'),
    );

    const systemMessage: ChatMessage = {
        id: `system-agent-${Date.now()}`,
        role: MessageRole.System,
        content: systemPrompt,
        timestamp: Date.now(),
    };

        let withSystem: ChatMessage[];
        if (agentSystemIndex !== -1) {
            withSystem = [...request.messages];
            withSystem[agentSystemIndex] = systemMessage;
        } else {
            withSystem = [systemMessage, ...request.messages];
        }

        // Cap retained screenshots before any token windowing — older
        // browser_observe results keep their AX tree (text) but drop the
        // base64 JPEG to bound token cost across multi-step sessions.
        const capped = trimScreenshotPayload(withSystem, 3);
        if (capped.strippedCount > 0) {
            console.log(
                `[ai-service] Screenshot retention: stripped ${capped.strippedCount}, retained ${capped.retainedCount}`,
            );
        }

        if (featureFlags.memorySlidingWindow) {
            const trimmed = trimToTokenBudget(capped.messages, windowBudget);
            if (trimmed.droppedCount > 0) {
                console.log(
                    `[ai-service] Memory window dropped ${trimmed.droppedCount} message(s) — ${trimmed.tokensBefore} → ${trimmed.tokensAfter} est. tokens (budget ${windowBudget}, ctx ${budget.contextWindow})`,
                );
            }
            return trimmed.messages;
        }
        return capped.messages;
    } catch (error) {
        console.error('[ai-service] Error in prepareMessages:', error);
        console.error('[ai-service] Request:', request);
        // Return messages without modification if there's an error
        return request.messages;
    }
}

/**
 * Create a new chat message
 */
export function createMessage(
    role: MessageRole,
    content: string,
    contextPaths?: string[]
): ChatMessage {
    return {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        role,
        content,
        timestamp: Date.now(),
        contextPaths,
    };
}

/**
 * Get the recommended default model. Prefers larger models since the only
 * mode is Agent (which benefits from stronger tool-using models).
 */
export function getDefaultModelForMode(
    _mode: AIMode | undefined,
    availableModels: ModelConfig[]
): ModelConfig | null {
    const recommendedModels = availableModels.filter((m) =>
        m.recommendedFor.includes(AIMode.Agent)
    );
    const pool = recommendedModels.length > 0 ? recommendedModels : availableModels;
    if (pool.length === 0) return null;
    return [...pool].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))[0];
}

/**
 * Pull/Download a model from Ollama
 */
export async function pullOllamaModel(
    modelName: string,
    endpoint: string = 'http://localhost:11434',
    onProgress?: (data: any) => void
): Promise<void> {
    try {
        const response = await fetch(`${endpoint}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName, stream: true }),
        });

        if (!response.ok) {
            throw new Error(`Ollama pull failed: ${response.statusText}`);
        }

        if (!response.body) throw new Error('No response body');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');

            // Process all complete lines
            for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i].trim();
                if (line) {
                    try {
                        const json = JSON.parse(line);
                        if (json.error) throw new Error(json.error);
                        onProgress?.(json);
                    } catch (e) {
                        console.error("Error parsing JSON line:", e);
                    }
                }
            }

            // Keep the last partial line in buffer
            buffer = lines[lines.length - 1];
        }

    } catch (error) {
        console.error('Failed to pull model:', error);
        throw error;
    }
}
