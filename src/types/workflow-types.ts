// Workflow system v2 types.
//
// v1 (WorkflowFileV1) is the original schema — raw tool call tape with no
// intents, no actor model, no retry policy. Still supported for loading.
// v2 (WorkflowFileV2) adds intent-annotated, actor-aware, parameterized steps
// with postcondition verification and a three-tier recovery model.

// ─── Shared primitives ──────────────────────────────────────────────────────

export type ActorKind = 'auto' | 'agent' | 'human';
export type StepRunStatus =
  | 'pending'
  | 'resolving_inputs'
  | 'awaiting_human_input'
  | 'running'
  | 'verifying'
  | 'agent_recovery'
  | 'awaiting_human_intervention'
  | 'done'
  | 'skipped'
  | 'failed';

// ─── v1 schema (original, kept for backward compat) ─────────────────────────

export interface WorkflowStepV1 {
  tool: string;
  params: Record<string, unknown>;
  classification: string;
  observedUrl?: string;
  observedTitle?: string;
}

export interface WorkflowParameterV1 {
  name: string;
  type: string;
  required: boolean;
}

export interface WorkflowFileV1 {
  version?: 1 | undefined;
  name: string;
  slug: string;
  createdAt: string;
  modelUsed?: string | null;
  parameters: WorkflowParameterV1[];
  steps: WorkflowStepV1[];
}

// ─── v2 schema ───────────────────────────────────────────────────────────────

export interface Postcondition {
  type: 'url_pattern' | 'selector_exists' | 'text_contains' | 'variable_extracted' | 'none';
  value: string;
  timeoutMs: number;
}

export interface RetryPolicy {
  maxAuto: number;
  escalateTo: 'agent' | 'human' | 'abort';
  agentHint?: string;
}

export interface HumanInput {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'checkbox';
  options?: string[];
  required: boolean;
  sensitive?: boolean;
}

export interface ProducesSpec {
  from: 'url_regex' | 'ax_selector' | 'page_title';
  pattern: string;
  group?: number;
}

export interface WorkflowStepV2 {
  id: string;
  intent: string;
  description?: string;
  tool: string;
  params: Record<string, unknown>;
  actor: ActorKind;
  runIf?: string;
  humanPrompt?: string;
  humanInputs?: HumanInput[];
  requiresVariables?: string[];
  producesVariable?: string;
  producesFrom?: ProducesSpec;
  postcondition?: Postcondition;
  retry: RetryPolicy;
  failureHints?: string[];
  // v1 compat fields
  classification: string;
  observedUrl?: string;
  observedTitle?: string;
}

export type VariableSource =
  | 'human_input'
  | 'conversation_context'
  | 'literal'
  | 'step_output';

export interface WorkflowVariable {
  name: string;
  type: 'string' | 'number' | 'boolean';
  source: VariableSource;
  defaultValue?: string;
  description: string;
  sensitive?: boolean;
}

export interface WorkflowFileV2 {
  version: 2;
  name: string;
  slug: string;
  description: string;
  goal: string;
  createdAt: string;
  modelUsed?: string | null;
  schedule?: string;
  variables: WorkflowVariable[];
  steps: WorkflowStepV2[];
}

// Union type — load either version
export type WorkflowFile = WorkflowFileV1 | WorkflowFileV2;

export function isV2(wf: WorkflowFile): wf is WorkflowFileV2 {
  return (wf as WorkflowFileV2).version === 2;
}

// ─── Run state (checkpoint) ──────────────────────────────────────────────────

export interface RecoveryAction {
    tool: string;
    params: Record<string, unknown>;
    executionTimeMs?: number;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inferenceTimeMs: number;
}

export interface StepAttempt {
  n: number;
  actor: 'auto' | 'agent';
  startedAt: string;
  error?: string;
  screenshotB64?: string;
  agentReasoning?: string;
  agentModel?: string;
  agentUsage?: AgentUsage;
}

export interface WorkflowStepRun {
  stepId: string;
  status: StepRunStatus;
  attempts: StepAttempt[];
  resolvedInputs: Record<string, unknown>;
  outputValue?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type PauseReason =
  | 'human_input'
  | 'human_intervention'
  | 'approval'
  | 'agent_recovery_failed';

export type GateType = 'human_input' | 'human_intervention' | 'approval';

export interface PendingGate {
  gateType: GateType;
  stepIndex: number;
  prompt: string;
  /** HumanInput[] for human_input gates */
  inputs?: HumanInput[];
  /** Extra context (agentReasoning, screenshot, risk, etc.) */
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowRun {
  runId: string;
  workflowSlug: string;
  startedAt: string;
  status: RunStatus;
  resolvedVars: Record<string, unknown>;
  stepRuns: WorkflowStepRun[];
  pausedAtStep?: number;
  pauseReason?: PauseReason;
  gateData?: PendingGate;
  sourceConversationId?: string;
}

export interface TraceEvent {
  id: number;
  runId: string;
  stepIndex: number | null;
  attemptNumber: number | null;
  eventType: string;
  eventData: Record<string, unknown>;
  createdAt: string;
}

// ─── Summary (list view) ─────────────────────────────────────────────────────

export interface WorkflowSummary {
  name: string;
  slug: string;
  description?: string;
  createdAt: string;
  stepCount: number;
  variableCount: number;
  version: number;
  path: string;
}

// ─── Enrichment (post-recording LLM hints) ───────────────────────────────────

export interface VariableHint {
  name: string;
  foundInStep: number;
  hardcodedValue: string;
  suggestedSource: VariableSource;
}

export interface EnrichedStepHint {
  rawStepIndices: number[];
  intent: string;
  description?: string;
  actor: ActorKind;
  requiresVariables: string[];
  failureHints?: string[];
}

export interface EnrichmentHints {
  suggestedName: string;
  description: string;
  goal: string;
  steps: EnrichedStepHint[];
  variables: VariableHint[];
}

// ─── Schedule types ──────────────────────────────────────────────────────────

export interface WorkflowSchedule {
  id: number;
  workflowSlug: string;
  cronExpression: string;
  variables: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Non-browser executor response types ──────────────────────────────────────

export interface ShellExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface HttpRequestResponse {
  status: number;
  statusText: string;
  body: string;
}
