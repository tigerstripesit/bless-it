// Agent recovery loop — called when a workflow step fails auto-retry.
//
// Injects full context (workflow goal, resolved variables, step intent,
// error, current AX snapshot + screenshot) into the LLM via a focused
// prompt. The model gets a limited tool set (browser_observe, browser_act,
// browser_navigate for the active session) and at most MAX_RECOVERY_STEPS
// tool calls to complete the intended step.
//
// Returns { ok, reasoning, screenshot } — the engine decides whether to
// accept the result or escalate further to a human.

import { runInferenceWithTools } from '@/lib/ai/inference-with-tools';
import { runInference } from '@/lib/ai/ai-service';
import type { InferenceResponse } from '@/types/ai-types';
import { invoke } from '@tauri-apps/api/core';
import { ModelConfig, AIMode, MessageRole, ModelProvider } from '@/types/ai-types';
import type { WorkflowStepV2, WorkflowRun, RecoveryAction } from '@/types/workflow-types';
import type { ToolExecutionEvent } from '@/lib/ai/inference-with-tools';

function toolProgressMessage(event: ToolExecutionEvent): string {
    const args = event.arguments ?? {};
    const done = event.result !== undefined || event.error !== undefined;
    if (!done) {
        // Tool just started executing
        if (event.toolName === 'browser_observe') return 'Agent looking at the page…';
        if (event.toolName === 'browser_navigate') return `Agent navigating to ${args.url ?? ''}…`;
        if (event.toolName === 'browser_open') return 'Agent opening browser…';
        if (event.toolName === 'browser_act') {
            const action = String(args.action ?? 'interact');
            if (action === 'click') return `Agent clicking element ${args.index ?? ''}…`;
            if (action === 'type') return `Agent typing into element ${args.index ?? ''}…`;
            return `Agent ${action} on element ${args.index ?? ''}…`;
        }
        return `Agent calling ${event.toolName}…`;
    }
    // Tool completed
    if (event.toolName === 'browser_observe') return 'Agent read the page — deciding next action…';
    if (event.toolName === 'browser_act') return 'Action complete — checking result…';
    if (event.toolName === 'browser_navigate') return 'Navigation complete…';
    return '';
}

const MAX_RECOVERY_STEPS = 5;

const RECOVERY_SYSTEM = `You are a workflow recovery agent. A single workflow step has failed and you must fix it.

Your ONLY job is to complete the ONE step described in <step-intent>. Do NOT proceed beyond it.
Use browser_observe to understand the current page state, then use browser_act or browser_navigate to complete the intent.
Stop as soon as the step is done — do not continue to subsequent steps.

Constraints:
- Maximum ${MAX_RECOVERY_STEPS} tool calls total.
- Only use browser_observe, browser_navigate, browser_act for the given session_id.
- Do NOT submit forms or take destructive actions unless the step intent explicitly requires it.
- After your tool calls, respond with a brief one-sentence summary of what you did and whether it succeeded.`;

function buildRecoveryPrompt(
    step: WorkflowStepV2,
    run: WorkflowRun,
    lastError: string,
    attemptN: number,
    currentObservation: string,
): string {
    return `<workflow-step-recovery>
  <goal>${run.workflowSlug}</goal>
  <variables>${JSON.stringify(run.resolvedVars, null, 2)}</variables>
  <step-intent>${step.intent}</step-intent>
  <attempt>${attemptN}</attempt>
  <error>${lastError}</error>${step.retry.agentHint ? `\n  <hint>${step.retry.agentHint}</hint>` : ''}
</workflow-step-recovery>

Current page state:
${currentObservation}

Complete the step: "${step.intent}"`;
}

export async function observeCurrentPage(sessionId: string): Promise<{ text: string; screenshot?: string }> {
    try {
        const result = await invoke<{
            url?: string;
            title?: string;
            ax?: Array<{ index: number; role: string; name: string; value?: string }>;
            screenshot?: string;
        }>('browser_rpc', {
            request: { method: 'browser.observe', params: { session_id: sessionId, include_screenshot: true } },
        });

        const ax = result.ax ?? [];
        const lines: string[] = [
            `url: ${result.url ?? '(unknown)'}`,
            `title: ${result.title ?? '(unknown)'}`,
            `ax (${ax.length} nodes):`,
        ];
        for (const n of ax.slice(0, 60)) {
            const parts = [`  [${n.index}] role=${n.role}`];
            if (n.name) parts.push(`name="${n.name}"`);
            if (n.value) parts.push(`value="${n.value}"`);
            lines.push(parts.join(' '));
        }
        if (ax.length > 60) lines.push(`  … ${ax.length - 60} more nodes`);

        return { text: lines.join('\n'), screenshot: result.screenshot };
    } catch {
        return { text: '(could not observe current page)', screenshot: undefined };
    }
}

export interface RecoveryResult {
    ok: boolean;
    reasoning: string;
    screenshot?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    inferenceTimeMs?: number;
    modelId?: string;
    recoveryActions?: RecoveryAction[];
}

const FORWARD_SYSTEM = `You are a workflow step executor. Complete exactly ONE step in the browser.

Use browser_observe to see the current page, then use browser_act or browser_navigate to carry out the intent.
Stop immediately once the step is done — do not continue to the next step.

Constraints:
- Maximum ${MAX_RECOVERY_STEPS} tool calls total.
- Only use browser_observe, browser_navigate, browser_act for the given session_id.
- NEVER click elements whose name starts with "Skip to" — they are off-screen accessibility shortcuts that will always time out. Skip past any such indices.
- After your actions, reply with one sentence confirming what you did.`;

function buildForwardPrompt(
    step: WorkflowStepV2,
    resolvedVars: Record<string, unknown>,
    currentObservation: string,
): string {
    return `<workflow-step>
  <intent>${step.intent}</intent>${step.retry.agentHint ? `\n  <hint>${step.retry.agentHint}</hint>` : ''}
  <variables>${JSON.stringify(resolvedVars, null, 2)}</variables>
</workflow-step>

Current page state:
${currentObservation}

Execute the step: "${step.intent}"`;
}

export async function agentForwardStep(
    step: WorkflowStepV2,
    resolvedVars: Record<string, unknown>,
    sessionId: string,
    modelConfig: ModelConfig,
    onProgress?: (message: string) => void,
): Promise<RecoveryResult> {
    onProgress?.('Agent observing page…');

    const { text: observation, screenshot } = await observeCurrentPage(sessionId);

    const prompt = buildForwardPrompt(step, resolvedVars, observation);

    const browserTools = [
        {
            type: 'function' as const,
            function: {
                name: 'browser_observe',
                description: 'Capture the current page AX tree and screenshot.',
                parameters: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        include_screenshot: { type: 'boolean' },
                    },
                    required: ['session_id'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'browser_act',
                description: 'Click, type, or interact with an element by AX index.',
                parameters: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        action: { type: 'string', enum: ['click', 'type', 'select', 'hover', 'scroll', 'press'] },
                        index: { type: 'number' },
                        text: { type: 'string' },
                        submit: { type: 'boolean' },
                    },
                    required: ['session_id', 'action'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'browser_navigate',
                description: 'Navigate to a URL.',
                parameters: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        url: { type: 'string' },
                    },
                    required: ['session_id', 'url'],
                },
            },
        },
    ];

    const agentCalls: RecoveryAction[] = [];

    try {
        const response = await runInferenceWithTools(
            {
                sessionId: `agent-step-${step.id}`,
                modelConfig,
                messages: [
                    {
                        id: 'sys',
                        role: MessageRole.System,
                        content: FORWARD_SYSTEM,
                        timestamp: Date.now(),
                    },
                    {
                        id: 'user',
                        role: MessageRole.User,
                        content: prompt,
                        images: screenshot ? [screenshot] : undefined,
                        timestamp: Date.now(),
                    },
                ],
                mode: AIMode.Agent,
                tools: modelConfig.provider === ModelProvider.OpenAICompatible || modelConfig.provider === ModelProvider.LlamaCpp
                    ? browserTools
                    : undefined,
                suppressTools: false,
                skipSystemPrompt: true,
            },
            {
                onChunk: () => {},
                onConfirmExecution: async () => true,
                onToolExecution: (event) => {
                    if (event.toolName !== 'browser_observe') {
                        agentCalls.push({
                            tool: event.toolName,
                            params: event.arguments,
                            executionTimeMs: event.executionTimeMs,
                        });
                    }
                    const msg = toolProgressMessage(event);
                    if (msg) onProgress?.(msg);
                },
            },
        );

        const reasoning = response.message.content ?? '';
        const failed = reasoning.toLowerCase().includes('failed') ||
            reasoning.toLowerCase().includes('unable') ||
            reasoning.toLowerCase().includes('could not') ||
            reasoning.toLowerCase().includes('error');

        const afterObs = await observeCurrentPage(sessionId);
        return {
            ok: !failed,
            reasoning,
            screenshot: afterObs.screenshot,
            usage: response.usage,
            inferenceTimeMs: response.inferenceTimeMs,
            modelId: modelConfig.modelId,
            recoveryActions: agentCalls,
        };
    } catch (err) {
        return {
            ok: false,
            reasoning: `Agent step error: ${err instanceof Error ? err.message : String(err)}`,
            screenshot,
            recoveryActions: agentCalls,
        };
    }
}

export async function agentRecoveryLoop(
    step: WorkflowStepV2,
    run: WorkflowRun,
    lastError: string,
    sessionId: string,
    modelConfig: ModelConfig,
    onProgress?: (message: string) => void,
): Promise<RecoveryResult> {
    onProgress?.('Agent observing page to recover failed step…');

    const { text: observation, screenshot } = await observeCurrentPage(sessionId);

    const recoveryPrompt = buildRecoveryPrompt(step, run, lastError, 1, observation);

    // Build a limited tool set scoped to the active session
    const browserTools = [
        {
            type: 'function' as const,
            function: {
                name: 'browser_observe',
                description: 'Capture the current page AX tree and screenshot.',
                parameters: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        include_screenshot: { type: 'boolean' },
                    },
                    required: ['session_id'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'browser_act',
                description: 'Click, type, or interact with an element by AX index.',
                parameters: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        action: { type: 'string', enum: ['click', 'type', 'select', 'hover', 'scroll', 'press'] },
                        index: { type: 'number' },
                        text: { type: 'string' },
                        submit: { type: 'boolean' },
                    },
                    required: ['session_id', 'action'],
                },
            },
        },
        {
            type: 'function' as const,
            function: {
                name: 'browser_navigate',
                description: 'Navigate to a URL.',
                parameters: {
                    type: 'object',
                    properties: {
                        session_id: { type: 'string' },
                        url: { type: 'string' },
                    },
                    required: ['session_id', 'url'],
                },
            },
        },
    ];

    const recoveryCalls: RecoveryAction[] = [];

    try {
        const response = await runInferenceWithTools(
            {
                sessionId: `recovery-${run.runId}-${step.id}`,
                modelConfig,
                messages: [
                    {
                        id: 'sys',
                        role: MessageRole.System,
                        content: RECOVERY_SYSTEM,
                        timestamp: Date.now(),
                    },
                    {
                        id: 'user',
                        role: MessageRole.User,
                        content: recoveryPrompt,
                        images: screenshot ? [screenshot] : undefined,
                        timestamp: Date.now(),
                    },
                ],
                mode: AIMode.Agent,
                tools: modelConfig.provider === ModelProvider.OpenAICompatible || modelConfig.provider === ModelProvider.LlamaCpp
                    ? browserTools
                    : undefined,
                suppressTools: false,
                skipSystemPrompt: true,
            },
            {
                onChunk: () => {},
                // Recovery steps don't need human approval — the engine already
                // classified the original step. Recovery actions inherit the same
                // classification. Write/destructive recovery steps would be
                // escalated to human by the engine before we got here.
                onConfirmExecution: async () => true,
                onToolExecution: (event) => {
                    if (event.toolName !== 'browser_observe') {
                        recoveryCalls.push({
                            tool: event.toolName,
                            params: event.arguments,
                            executionTimeMs: event.executionTimeMs,
                        });
                    }
                    const msg = toolProgressMessage(event);
                    if (msg) onProgress?.(msg);
                },
            },
        );

        const reasoning = response.message.content ?? '';
        const succeeded = !reasoning.toLowerCase().includes('failed') &&
            !reasoning.toLowerCase().includes('unable') &&
            !reasoning.toLowerCase().includes('could not');

        const afterObs = await observeCurrentPage(sessionId);
        return {
            ok: succeeded,
            reasoning,
            screenshot: afterObs.screenshot,
            usage: response.usage,
            inferenceTimeMs: response.inferenceTimeMs,
            modelId: modelConfig.modelId,
            recoveryActions: recoveryCalls,
        };
    } catch (err) {
        return {
            ok: false,
            reasoning: `Recovery agent error: ${err instanceof Error ? err.message : String(err)}`,
            screenshot,
            recoveryActions: recoveryCalls,
        };
    }
}
