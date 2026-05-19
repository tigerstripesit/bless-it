// Workflow recording enricher — post-processes raw v1 steps into a v2 definition.
//
// After Stop & Save, the raw recording is a flat list of low-level browser_rpc
// calls with no intent labels, no actor classification, and no variable
// declarations. This module calls the active LLM once to:
//   1. Group related tool calls into logical steps (navigate+observe+act → one step)
//   2. Infer a human-readable intent for each logical step
//   3. Classify actor: auto / agent / human
//   4. Identify hardcoded values that should become {{ variables }}
//
// The result is EnrichmentHints — reviewed by the user in WorkflowRecordingReview
// before the final v2 file is saved. If the LLM call fails, the UI degrades
// gracefully: each raw step becomes an unlabelled v2 step that the user labels
// manually.

import { runInference } from '@/lib/ai/ai-service';
import { ModelConfig, AIMode, MessageRole } from '@/types/ai-types';
import type { WorkflowStepV1, EnrichmentHints, EnrichedStepHint, VariableHint } from '@/types/workflow-types';

const ENRICHMENT_SYSTEM = `You are a workflow analysis assistant. Given a list of raw browser automation steps (JSON-RPC calls), produce a structured analysis in valid JSON.

Your job:
1. Group consecutive low-level steps that achieve ONE logical action (e.g. navigate+observe+act on a form field = one "Fill X field" step).
2. Write a short, plain-language intent for each group (e.g. "Click the 'Create Issue' button").
3. Classify the actor for each group:
   - "auto": deterministic, no LLM needed (navigating to a known URL, clicking a known button)
   - "agent": LLM fills from conversation context (form fields whose values depend on the task at hand)
   - "human": must pause (login forms, password fields, approval checkboxes, CAPTCHAs)
4. Identify hardcoded values in params that should become {{ variables }} (emails, names, ticket IDs, usernames).
5. Suggest a workflow name, description (one sentence), and goal (end state after success).
6. For each step, provide an optional 'description' explaining what the step does and why.
7. For each step, provide optional 'failureHints' — an array of plain-language troubleshooting tips for the user if this step fails.

Rules:
- browser_observe steps are read-only navigation aids — fold them into the surrounding act/navigate step, do not make them standalone steps.
- If a step fills a password field (tags include "password"), always classify actor as "human".
- If a step fills any text field with a specific value that clearly comes from task context (username, email, summary text), classify as "agent" and suggest a variable.
- Keep intents concise — under 10 words.
- Return ONLY valid JSON, no markdown fences, no explanation.`;

const ENRICHMENT_USER_TEMPLATE = `Raw workflow steps (JSON):
{steps}

Observed page contexts:
{contexts}

Return this exact JSON shape:
{
  "suggestedName": "kebab-case-name",
  "description": "One sentence describing what this workflow does.",
  "goal": "End state after workflow succeeds.",
  "steps": [
    {
      "rawStepIndices": [0, 1, 2],
      "intent": "Navigate to the Jira service desk",
      "description": "Explain what this step does in detail, including why it exists",
      "actor": "auto",
      "requiresVariables": [],
      "failureHints": [
        "Actions the user should try if this step fails, e.g. 'Check that the Jira URL is reachable'"
      ]
    }
  ],
  "variables": [
    {
      "name": "username",
      "foundInStep": 3,
      "hardcodedValue": "john.doe@company.com",
      "suggestedSource": "conversation_context"
    }
  ]
}`;

function buildContextSummary(steps: WorkflowStepV1[]): string {
    const pages = new Map<string, string>();
    for (const step of steps) {
        if (step.observedUrl && step.observedTitle) {
            pages.set(step.observedUrl, step.observedTitle);
        }
    }
    if (pages.size === 0) return '(none observed)';
    return [...pages.entries()]
        .map(([url, title]) => `${url} — "${title}"`)
        .join('\n');
}

function buildStepSummary(steps: WorkflowStepV1[]): string {
    return JSON.stringify(
        steps.map((s, i) => ({
            index: i,
            tool: s.tool,
            classification: s.classification,
            url: s.observedUrl,
            title: s.observedTitle,
            params: stripLargeFields(s.params),
        })),
        null,
        2,
    );
}

function stripLargeFields(params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        if (k === 'screenshot' || k === 'session_id') continue;
        if (typeof v === 'string' && v.length > 200) {
            out[k] = v.slice(0, 200) + '…';
        } else {
            out[k] = v;
        }
    }
    return out;
}

function fallbackHints(steps: WorkflowStepV1[]): EnrichmentHints {
    return {
        suggestedName: 'my-workflow',
        description: '',
        goal: '',
        steps: steps
            .filter((s) => s.tool !== 'browser.observe')
            .map((s, i) => ({
                rawStepIndices: [i],
                intent: '',
                actor: s.classification === 'destructive' ? 'human' : 'auto',
                requiresVariables: [],
            } satisfies EnrichedStepHint)),
        variables: [],
    };
}

function parseEnrichmentResponse(text: string): EnrichmentHints {
    const trimmed = text.trim();
    // Strip markdown fences if the model added them despite instructions
    const jsonText = trimmed.startsWith('```')
        ? trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        : trimmed;
    const parsed = JSON.parse(jsonText) as EnrichmentHints;
    // Basic validation — ensure required arrays exist
    if (!Array.isArray(parsed.steps)) parsed.steps = [];
    if (!Array.isArray(parsed.variables)) parsed.variables = [];
    return parsed;
}

export async function enrichRecording(
    rawSteps: WorkflowStepV1[],
    modelConfig: ModelConfig,
): Promise<EnrichmentHints> {
    if (rawSteps.length === 0) return fallbackHints(rawSteps);

    const userMessage = ENRICHMENT_USER_TEMPLATE
        .replace('{steps}', buildStepSummary(rawSteps))
        .replace('{contexts}', buildContextSummary(rawSteps));

    try {
        const response = await runInference({
            sessionId: `workflow-enrich-${Date.now()}`,
            modelConfig,
            messages: [
                {
                    id: 'sys',
                    role: MessageRole.System,
                    content: ENRICHMENT_SYSTEM,
                    timestamp: Date.now(),
                },
                {
                    id: 'user',
                    role: MessageRole.User,
                    content: userMessage,
                    timestamp: Date.now(),
                },
            ],
            mode: AIMode.Agent,
            suppressTools: true,
            skipSystemPrompt: true,
        });

        const content = response.message.content ?? '';
        if (!content.trim()) return fallbackHints(rawSteps);
        return parseEnrichmentResponse(content);
    } catch (err) {
        console.warn('[workflow-enricher] LLM enrichment failed, using fallback:', err);
        return fallbackHints(rawSteps);
    }
}

// Convert raw v1 steps + enrichment hints into a full v2 step list.
// Used by WorkflowRecordingReview to build the initial draft before user review.
export function applyHintsToSteps(
    rawSteps: WorkflowStepV1[],
    hints: EnrichmentHints,
): import('@/types/workflow-types').WorkflowStepV2[] {
    const { WorkflowStepV2 } = {} as never; // type-only import trick — we build objects directly
    void WorkflowStepV2;

    return hints.steps.map((hint) => {
        // Take the last raw step in the group as the "action" step (the one that
        // actually does something). The others were observe/navigate intermediates.
        const groupIndices = hint.rawStepIndices;
        const actionIdx = groupIndices[groupIndices.length - 1] ?? 0;
        const raw = rawSteps[actionIdx] ?? rawSteps[0];

        return {
            id: crypto.randomUUID(),
            intent: hint.intent,
            description: hint.description || undefined,
            tool: raw.tool,
            params: raw.params,
            actor: hint.actor as import('@/types/workflow-types').ActorKind,
            requiresVariables: hint.requiresVariables.length > 0 ? hint.requiresVariables : undefined,
            retry: {
                maxAuto: hint.actor === 'auto' ? 2 : 1,
                escalateTo: hint.actor === 'human' ? 'human' : 'agent',
            },
            failureHints: hint.failureHints && hint.failureHints.length > 0 ? hint.failureHints : undefined,
            classification: raw.classification,
            observedUrl: raw.observedUrl,
            observedTitle: raw.observedTitle,
        };
    });
}
