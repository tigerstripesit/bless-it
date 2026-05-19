// Workflow execution engine — the core of the production-grade harness.
//
// Three-tier recovery model per step:
//   Tier 1 (auto): execute → if fail, retry up to RetryPolicy.maxAuto times
//   Tier 2 (agent): if auto retries exhausted and escalateTo='agent',
//                   invoke agentRecoveryLoop with full page context
//   Tier 3 (human): if agent fails or escalateTo='human',
//                   pause and hand to the user via onHumanInterventionRequired
//
// Durable checkpoints: every step state change is persisted via
// workflow_run_checkpoint so an app restart can resume from the last
// completed step.
//
// Supports both v1 (raw tape) and v2 (intent-annotated) workflow files.

import { invoke } from '@tauri-apps/api/core';
import type {
    WorkflowFile,
    WorkflowFileV1,
    WorkflowFileV2,
    WorkflowStepV1,
    WorkflowStepV2,
    WorkflowRun,
    WorkflowStepRun,
    StepAttempt,
    StepRunStatus,
    Postcondition,
    ActorKind,
    HumanInput,
    PendingGate,
    GateType,
    TraceEvent,
    RecoveryAction,
    ShellExecResponse,
    HttpRequestResponse,
} from '@/types/workflow-types';
import { isV2 } from '@/types/workflow-types';
import { classifyBrowserAction, type BrowserRisk } from '@/lib/ai/browser-classify';
import { agentRecoveryLoop, agentForwardStep } from './agent-recovery';
import type { ModelConfig } from '@/types/ai-types';

// ── Callbacks ──────────────────────────────────────────────────────────────

export interface EngineCallbacks {
    /** Step status changed (called on every transition). */
    onStepStatus(
        stepIndex: number,
        status: StepRunStatus,
        attempt?: StepAttempt,
    ): void;
    /** A workflow variable was resolved to a value. */
    onVariableResolved(name: string, value: unknown): void;
    /** The current step needs human form-input before it can execute. */
    onHumanInputRequired(
        step: WorkflowStepV2,
        prompt: string,
        inputs: HumanInput[],
    ): Promise<Record<string, unknown>>;
    /** A step failed all auto+agent retries and the human must fix it in the browser. */
    onHumanInterventionRequired(
        stepIndex: number,
        message: string,
        agentReasoning?: string,
        screenshot?: string,
    ): Promise<'resume' | 'skip' | 'abort'>;
    /** A write/destructive step needs explicit approval before executing. */
    onApprovalRequired(
        stepIndex: number,
        risk: BrowserRisk,
        intent: string,
        screenshot?: string,
    ): Promise<boolean>;
    /** Agent recovery started/progressing. */
    onAgentRecoveryProgress(stepIndex: number, message: string): void;
    /** Trace event emitted during workflow execution. */
    onTraceEvent(event: TraceEvent): void;
    /**
     * Called before human intervention to offer the user a chance to repair
     * the step definition. Return a repaired step to re-execute, or null
     * to proceed to the human intervention gate.
     */
    onStepRepairRequested(
        stepIndex: number,
        step: WorkflowStepV2,
        lastError: string,
        screenshot?: string,
    ): Promise<WorkflowStepV2 | null>;
    /**
     * Called after agent recovery (or agent forward) succeeds with tool calls
     * that aren't in the original workflow step. Non-blocking — the workflow
     * continues executing. The UI may surface a "Save fix to workflow" prompt.
     */
    onFixAvailable(
        stepIndex: number,
        recoveryActions: RecoveryAction[],
        reasoning: string,
    ): void;
}

// ── Public engine interface ────────────────────────────────────────────────

export interface RunResult {
    status: 'completed' | 'failed' | 'cancelled' | 'aborted';
    resolvedVars: Record<string, unknown>;
    runId: string;
}

export class WorkflowEngine {
    private aborted = false;
    private runId: string | null = null;

    abort() { this.aborted = true; }
    get isAborted() { return this.aborted; }

    private async _trace(
        eventType: string,
        stepIndex: number | null,
        attemptNumber: number | null,
        eventData: Record<string, unknown>,
    ) {
        if (!this.runId) return;
        const event: TraceEvent = {
            id: 0,
            runId: this.runId,
            stepIndex,
            attemptNumber,
            eventType,
            eventData,
            createdAt: new Date().toISOString(),
        };
        // Fire-and-forget persist to SQLite
        invoke('workflow_trace_event_insert', { event: { runId: this.runId, stepIndex, attemptNumber, eventType, eventData } }).catch(() => {});
        // Notify UI
        this._lastCallbacks?.onTraceEvent(event);
    }

    private _lastCallbacks: EngineCallbacks | null = null;

    /**
     * Dispatch a tool call to the appropriate backend command based on tool name.
     * Browser tools → browser_rpc, system tools → dedicated Tauri commands.
     */
    private async _executeToolCall(
        tool: string,
        params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        if (tool.startsWith('browser.')) {
            return await invoke<Record<string, unknown>>('browser_rpc', {
                request: { method: tool, params },
            });
        }

        switch (tool) {
            case 'shell.exec':
                return await invoke<ShellExecResponse>('workflow_shell_exec', {
                    command: params.command as string,
                    workingDir: params.working_dir as string | undefined,
                    timeoutSecs: params.timeout_secs as number | undefined,
                }) as unknown as Record<string, unknown>;

            case 'http.request':
                return await invoke<HttpRequestResponse>('workflow_http_request', {
                    method: params.method as string,
                    url: params.url as string,
                    headers: params.headers as Array<[string, string]> | undefined,
                    body: params.body as Record<string, unknown> | undefined,
                    timeoutSecs: params.timeout_secs as number | undefined,
                }) as unknown as Record<string, unknown>;

            case 'workflow.run': {
                const slug = params.slug as string;
                const variables = params.variables as Record<string, unknown> | undefined;
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('workflow:run', {
                        detail: { slug, variables: variables ?? {} },
                    }));
                }
                return { launched: true, slug };
            }

            case 'human.gate': {
                const prompt = params.prompt as string;
                const inputs = params.inputs as Array<{ name: string; label: string; type: string }> | undefined;
                if (this._lastCallbacks?.onHumanInputRequired) {
                    const values = await this._lastCallbacks.onHumanInputRequired(
                        { tool, params } as unknown as WorkflowStepV2,
                        prompt,
                        (inputs ?? []).map(i => ({
                            name: i.name,
                            label: i.label,
                            type: (i.type || 'text') as HumanInput['type'],
                            required: true,
                        })),
                    );
                    return { confirmed: true, values };
                }
                return { confirmed: true };
            }

            case 'agent.task': {
                const instructions = params.instructions as string;
                const context = params.context as string | undefined;
                return {
                    delegated: true,
                    instructions,
                    context,
                    note: 'Agent task logged. The agent will process this in the next inference cycle.',
                };
            }

            default:
                throw new Error(`Unknown tool "${tool}" in workflow step`);
        }
    }

    async run(
        slug: string,
        inputVars: Record<string, unknown>,
        modelConfig: ModelConfig | null,
        callbacks: EngineCallbacks,
        sourceConversationId?: string,
    ): Promise<RunResult> {
        this.aborted = false;

        // Load the workflow file
        const wf = await invoke<WorkflowFile>('workflow_load', { slug });
        const { steps, resolvedVars } = normalizeWorkflow(wf, inputVars);

        // Create a durable run record
        const run = await invoke<WorkflowRun>('workflow_run_create', {
            workflowSlug: slug,
            resolvedVars,
            stepCount: steps.length,
            sourceConversationId: sourceConversationId ?? null,
        });
        this.runId = run.runId;
        this._lastCallbacks = callbacks;

        await this._trace('run_start', null, null, { slug, stepCount: steps.length });
        const result = await this._executeSteps(steps, run, resolvedVars, modelConfig, callbacks);
        await this._trace('run_complete', null, null, { status: result.status });
        return result;
    }

    async resume(
        run: WorkflowRun,
        modelConfig: ModelConfig | null,
        callbacks: EngineCallbacks,
    ): Promise<RunResult> {
        this.aborted = false;
        this.runId = run.runId;
        this._lastCallbacks = callbacks;

        const wf = await invoke<WorkflowFile>('workflow_load', { slug: run.workflowSlug });
        const { steps } = normalizeWorkflow(wf, {});
        const resolvedVars = run.resolvedVars as Record<string, unknown>;

        return this._executeSteps(steps, run, resolvedVars, modelConfig, callbacks, run.pausedAtStep ?? 0);
    }

    private async _executeSteps(
        steps: NormalizedStep[],
        run: WorkflowRun,
        resolvedVars: Record<string, unknown>,
        modelConfig: ModelConfig | null,
        callbacks: EngineCallbacks,
        startFrom = 0,
    ): Promise<RunResult> {
        for (let i = startFrom; i < steps.length; i++) {
            if (this.aborted) {
                await this._trace('run_cancel', i, null, { reason: 'abort' });
                await this._finalizeRun(run.runId, 'cancelled');
                return { status: 'cancelled', resolvedVars, runId: run.runId };
            }

            const step = steps[i];
            const stepRun = run.stepRuns[i] ?? emptyStepRun(step.id, i);

            callbacks.onStepStatus(i, 'running');

            let result = await this._executeStep(step, i, stepRun, run, resolvedVars, modelConfig, callbacks);

            // Handle step repair retry: reload the workflow and re-execute the step
            if (result === 'retry') {
                const wf = await invoke<WorkflowFile>('workflow_load', { slug: run.workflowSlug });
                const reloaded = normalizeWorkflow(wf, resolvedVars);
                const repairedStep = reloaded.steps[i];
                const repairedRun = run.stepRuns[i] ?? emptyStepRun(repairedStep.id, i);
                result = await this._executeStep(repairedStep, i, repairedRun, run, resolvedVars, modelConfig, callbacks);
                run.stepRuns[i] = repairedRun;
            }
            if (result === 'retry') {
                // Guard against infinite retry loops — fall through to failure
                result = 'failed';
            }

            if (result === 'aborted') {
                await this._trace('run_cancel', i, null, {});
                await this._finalizeRun(run.runId, 'cancelled');
                return { status: 'aborted', resolvedVars, runId: run.runId };
            }
            if (result === 'failed') {
                await this._trace('run_fail', i, null, {});
                await this._finalizeRun(run.runId, 'failed');
                return { status: 'failed', resolvedVars, runId: run.runId };
            }
            if (result.outputValue !== undefined && step.producesVariable) {
                resolvedVars[step.producesVariable] = result.outputValue;
                callbacks.onVariableResolved(step.producesVariable, result.outputValue);
            }

            callbacks.onStepStatus(i, 'done');
        }

        await this._finalizeRun(run.runId, 'completed');
        return { status: 'completed', resolvedVars, runId: run.runId };
    }

    private async _executeStep(
        step: NormalizedStep,
        stepIndex: number,
        stepRun: WorkflowStepRun,
        run: WorkflowRun,
        resolvedVars: Record<string, unknown>,
        modelConfig: ModelConfig | null,
        callbacks: EngineCallbacks,
    ): Promise<'aborted' | 'failed' | 'retry' | { outputValue?: unknown }> {

        // ── Human actor — full pause ─────────────────────────────────────
        if (step.actor === 'human') {
            callbacks.onStepStatus(stepIndex, 'awaiting_human_input');
            if (step.humanInputs && step.humanInputs.length > 0) {
                await this._persistGate(
                    run.runId, 'human_input', stepIndex,
                    step.humanPrompt ?? `Complete this step: ${step.intent}`,
                    step.humanInputs,
                );
                const values = await callbacks.onHumanInputRequired(
                    step as WorkflowStepV2,
                    step.humanPrompt ?? `Complete this step: ${step.intent}`,
                    step.humanInputs,
                );
                await this._resolveGate(run.runId, stepIndex, 'human_input');
                for (const [k, v] of Object.entries(values)) {
                    resolvedVars[k] = v;
                    callbacks.onVariableResolved(k, v);
                }
            } else {
                // No form inputs — just a human checkpoint / approval gate
                await this._persistGate(
                    run.runId, 'human_intervention', stepIndex,
                    step.humanPrompt ?? `Please complete: ${step.intent}`,
                );
                const decision = await callbacks.onHumanInterventionRequired(
                    stepIndex,
                    step.humanPrompt ?? `Please complete: ${step.intent}`,
                );
                await this._resolveGate(run.runId, stepIndex, 'human_intervention');
                if (decision === 'abort') return 'aborted';
            }
            await this._trace('step_ok', stepIndex, null, { actor: 'human' });
            await this._checkpoint(run.runId, stepIndex, { ...stepRun, status: 'done' });
            return {};
        }

        // ── Resolve variables in params ──────────────────────────────────
        const boundParams = bindVarsToParams(step.params, resolvedVars);

        // ── Approval gate for write/destructive ──────────────────────────
        const risk = classifyBrowserAction({ method: normalizeToolName(step.tool), params: boundParams });
        if (risk === 'write' || risk === 'destructive') {
            callbacks.onStepStatus(stepIndex, 'verifying');
            const screenshot = await getLastScreenshot(boundParams.session_id as string | undefined);
            await this._persistGate(
                run.runId, 'approval', stepIndex,
                `Approve ${risk} step: ${step.intent}`,
                undefined,
                { risk, screenshot },
            );
            const approved = await callbacks.onApprovalRequired(stepIndex, risk, step.intent, screenshot);
            await this._resolveGate(run.runId, stepIndex, 'approval');
            if (!approved) {
                await this._checkpoint(run.runId, stepIndex, { ...stepRun, status: 'skipped' });
                callbacks.onStepStatus(stepIndex, 'skipped');
                return {};
            }
        }

        // ── Agent-first execution (actor=agent) ──────────────────────────
        // For agent steps the LLM observes the live page and decides which
        // element to interact with — the hardcoded index in the JSON is only
        // a fallback hint, not an authoritative value.
        if (step.actor === 'agent' && modelConfig) {
            callbacks.onStepStatus(stepIndex, 'running');
            callbacks.onAgentRecoveryProgress(stepIndex, 'Agent reading page…');

            const sessionId = boundParams.session_id as string | undefined ?? '';
            const fwd = await agentForwardStep(
                step as WorkflowStepV2,
                resolvedVars,
                sessionId,
                modelConfig,
                (msg) => callbacks.onAgentRecoveryProgress(stepIndex, msg),
            );

            if (fwd.ok) {
                stepRun.status = 'done';
                stepRun.attempts.push({
                    n: 0,
                    actor: 'agent',
                    startedAt: new Date().toISOString(),
                    agentReasoning: fwd.reasoning,
                    screenshotB64: fwd.screenshot,
                    agentModel: fwd.modelId,
                    agentUsage: fwd.usage ? {
                        promptTokens: fwd.usage.promptTokens,
                        completionTokens: fwd.usage.completionTokens,
                        totalTokens: fwd.usage.totalTokens,
                        inferenceTimeMs: fwd.inferenceTimeMs ?? 0,
                    } : undefined,
                });
                await this._trace('step_ok', stepIndex, 0, { actor: 'agent', model: fwd.modelId });
                if (fwd.recoveryActions?.length) {
                    callbacks.onFixAvailable(stepIndex, fwd.recoveryActions, fwd.reasoning);
                }
                await this._checkpoint(run.runId, stepIndex, stepRun);
                return {};
            }

            await this._trace('step_fail', stepIndex, 0, { actor: 'agent', error: fwd.reasoning });
            // Agent forward failed — fall through to human intervention
            await this._persistGate(
                run.runId, 'human_intervention', stepIndex,
                `Step ${stepIndex + 1} failed: ${fwd.reasoning}`,
                undefined,
                { agentReasoning: fwd.reasoning, screenshot: fwd.screenshot },
            );
            const decision = await callbacks.onHumanInterventionRequired(
                stepIndex,
                `Step ${stepIndex + 1} failed: ${fwd.reasoning}`,
                fwd.reasoning,
                fwd.screenshot,
            );
            await this._resolveGate(run.runId, stepIndex, 'human_intervention');
            if (decision === 'abort') return 'aborted';
            if (decision === 'skip') {
                stepRun.status = 'skipped';
                await this._checkpoint(run.runId, stepIndex, stepRun);
                callbacks.onStepStatus(stepIndex, 'skipped');
                return {};
            }
            stepRun.status = 'done';
            await this._checkpoint(run.runId, stepIndex, stepRun);
            return {};
        }

        // ── Auto-retry loop ──────────────────────────────────────────────
        const maxAuto = step.retry?.maxAuto ?? 2;
        let lastError = '';
        let lastScreenshot: string | undefined;

        for (let attempt = 0; attempt <= maxAuto; attempt++) {
            if (this.aborted) return 'aborted';

            const attemptRecord: StepAttempt = {
                n: attempt,
                actor: 'auto',
                startedAt: new Date().toISOString(),
            };

            try {
                await this._trace('tool_call', stepIndex, attempt, { tool: step.tool });
                const result = await this._executeToolCall(step.tool, boundParams);
                await this._trace('tool_result', stepIndex, attempt, { tool: step.tool });

                // Postcondition verification
                if (step.postcondition && step.postcondition.type !== 'none') {
                    callbacks.onStepStatus(stepIndex, 'verifying');
                    const verified = await verifyPostcondition(step.postcondition, result, boundParams);
                    if (!verified) {
                        lastError = `Postcondition not met: ${step.postcondition.type} = "${step.postcondition.value}"`;
                        attemptRecord.error = lastError;
                        stepRun.attempts.push(attemptRecord);
                        await this._trace('step_fail', stepIndex, attempt, { error: lastError, reason: 'postcondition' });
                        await this._checkpoint(run.runId, stepIndex, stepRun);
                        continue; // retry
                    }
                }

                // Extract produces_variable if configured
                const outputValue = extractOutput(step, result);

                stepRun.status = 'done';
                stepRun.attempts.push({ ...attemptRecord, error: undefined });
                await this._trace('step_ok', stepIndex, attempt, { actor: 'auto' });
                await this._checkpoint(run.runId, stepIndex, stepRun);
                return { outputValue };

            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                lastScreenshot = (err as { screenshot?: string }).screenshot;
                attemptRecord.error = lastError;
                attemptRecord.screenshotB64 = lastScreenshot;
                stepRun.attempts.push(attemptRecord);
                await this._trace('step_fail', stepIndex, attempt, { error: lastError });
                await this._checkpoint(run.runId, stepIndex, stepRun);
            }
        }

        // ── Agent recovery ───────────────────────────────────────────────
        const escalateTo = step.retry?.escalateTo ?? 'human';
        if (escalateTo === 'agent' && modelConfig) {
            callbacks.onStepStatus(stepIndex, 'agent_recovery');
            callbacks.onAgentRecoveryProgress(stepIndex, 'Agent analysing failure…');

            await this._trace('recovery_start', stepIndex, null, { error: lastError });
            const sessionId = boundParams.session_id as string | undefined ?? '';
            const recovery = await agentRecoveryLoop(
                step as WorkflowStepV2,
                run,
                lastError,
                sessionId,
                modelConfig,
                (msg) => callbacks.onAgentRecoveryProgress(stepIndex, msg),
            );

            if (recovery.ok) {
                stepRun.status = 'done';
                stepRun.attempts.push({
                    n: maxAuto + 1,
                    actor: 'agent',
                    startedAt: new Date().toISOString(),
                    agentReasoning: recovery.reasoning,
                    screenshotB64: recovery.screenshot,
                    agentModel: recovery.modelId,
                    agentUsage: recovery.usage ? {
                        promptTokens: recovery.usage.promptTokens,
                        completionTokens: recovery.usage.completionTokens,
                        totalTokens: recovery.usage.totalTokens,
                        inferenceTimeMs: recovery.inferenceTimeMs ?? 0,
                    } : undefined,
                });
                await this._trace('recovery_ok', stepIndex, null, { model: recovery.modelId });
                if (recovery.recoveryActions?.length) {
                    callbacks.onFixAvailable(stepIndex, recovery.recoveryActions, recovery.reasoning);
                }
                await this._checkpoint(run.runId, stepIndex, stepRun);
                return {};
            }

            await this._trace('recovery_fail', stepIndex, null, { error: recovery.reasoning });
            // Agent recovery failed — fall through to human
            lastError = recovery.reasoning;
            lastScreenshot = recovery.screenshot;
        }

        // ── Step repair (before human intervention) ──────────────────────
        // Offer the user a chance to fix the step definition and retry.
        const repairedStep = await callbacks.onStepRepairRequested(
            stepIndex, step as WorkflowStepV2, lastError, lastScreenshot,
        );
        if (repairedStep) {
            // Save the repaired step to the workflow file
            try {
                const wf = await invoke<WorkflowFile>('workflow_load', { slug: run.workflowSlug });
                if (isV2(wf)) {
                    const updated: WorkflowFileV2 = {
                        ...wf,
                        steps: wf.steps.map((s, i) => i === stepIndex ? repairedStep : s),
                    };
                    await invoke('workflow_update', { definition: updated });
                }
            } catch (e) {
                console.warn('[workflow-engine] repair save failed:', e);
            }
            // Reset step run state for retry
            stepRun.status = 'resolving_inputs';
            stepRun.attempts = [];
            return 'retry' as const;
        }

        // ── Human intervention ───────────────────────────────────────────
        callbacks.onStepStatus(stepIndex, 'awaiting_human_intervention');
        await this._persistGate(
            run.runId, 'human_intervention', stepIndex,
            `Step ${stepIndex + 1} failed: ${lastError}`,
            undefined,
            { error: lastError, screenshot: lastScreenshot },
        );
        const decision = await callbacks.onHumanInterventionRequired(
            stepIndex,
            `Step ${stepIndex + 1} failed: ${lastError}`,
            escalateTo === 'agent' ? lastError : undefined,
            lastScreenshot,
        );
        await this._resolveGate(run.runId, stepIndex, 'human_intervention');

        if (decision === 'abort') return 'aborted';
        if (decision === 'skip') {
            stepRun.status = 'skipped';
            await this._checkpoint(run.runId, stepIndex, stepRun);
            callbacks.onStepStatus(stepIndex, 'skipped');
            return {};
        }

        // decision === 'resume' — user fixed it in the browser
        stepRun.status = 'done';
        await this._checkpoint(run.runId, stepIndex, stepRun);
        return {};
    }

    private async _checkpoint(runId: string, stepIndex: number, stepRun: WorkflowStepRun) {
        try {
            await invoke('workflow_run_checkpoint', {
                runId,
                stepIndex,
                stepRun,
                pausedAtStep: stepRun.status === 'awaiting_human_intervention' || stepRun.status === 'awaiting_human_input'
                    ? stepIndex
                    : null,
                pauseReason: stepRun.status === 'awaiting_human_input' ? 'human_input'
                    : stepRun.status === 'awaiting_human_intervention' ? 'human_intervention'
                    : null,
            });
        } catch (e) {
            console.warn('[workflow-engine] checkpoint failed:', e);
        }
    }

    private async _finalizeRun(runId: string, status: string) {
        try {
            await invoke('workflow_run_complete', { runId, status });
        } catch (e) {
            console.warn('[workflow-engine] finalize run failed:', e);
        }
    }

    /** Clear a resolved pending gate from the database. */
    private async _resolveGate(runId: string, stepIndex?: number, gateType?: string) {
        try {
            await invoke('workflow_run_resolve_gate', { runId });
            if (stepIndex !== undefined && gateType) {
                await this._trace('gate_resolve', stepIndex, null, { gateType });
            }
        } catch (e) {
            console.warn('[workflow-engine] resolve gate failed:', e);
        }
    }

    /** Persist a pending human gate so it survives app restart. */
    private async _persistGate(
        runId: string,
        gateType: GateType,
        stepIndex: number,
        prompt: string,
        inputs?: HumanInput[],
        metadata?: Record<string, unknown>,
    ) {
        try {
            const gate: PendingGate = {
                gateType,
                stepIndex,
                prompt,
                inputs,
                metadata,
                createdAt: new Date().toISOString(),
            };
            await invoke('workflow_run_pause_for_gate', { runId, gate });
            await this._trace('gate_pause', stepIndex, null, { gateType, prompt });
        } catch (e) {
            console.warn('[workflow-engine] persist gate failed:', e);
        }
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────

interface NormalizedStep extends Partial<WorkflowStepV2> {
    id: string;
    intent: string;
    tool: string;
    params: Record<string, unknown>;
    actor: ActorKind;
    classification: string;
    producesVariable?: string;
    retry: { maxAuto: number; escalateTo: 'agent' | 'human' | 'abort'; agentHint?: string };
}

function normalizeWorkflow(
    wf: WorkflowFile,
    inputVars: Record<string, unknown>,
): { steps: NormalizedStep[]; resolvedVars: Record<string, unknown> } {
    const resolvedVars = { ...inputVars };

    if (isV2(wf)) {
        // Seed defaults for variables not provided
        for (const v of wf.variables) {
            if (resolvedVars[v.name] === undefined && v.defaultValue !== undefined) {
                resolvedVars[v.name] = v.defaultValue;
            }
        }
        return {
            steps: wf.steps.map((s) => ({ ...s })),
            resolvedVars,
        };
    }

    // v1 — wrap each step in a minimal NormalizedStep
    const v1 = wf as WorkflowFileV1;
    for (const p of v1.parameters ?? []) {
        if (resolvedVars[p.name] === undefined && p.required) {
            // leave undefined — will surface as blank in the form
        }
    }
    return {
        steps: (v1.steps as WorkflowStepV1[]).map((s, i) => ({
            id: String(i),
            intent: `Step ${i + 1}: ${s.tool}`,
            tool: s.tool,
            params: s.params as Record<string, unknown>,
            actor: (s.classification === 'destructive' ? 'human' : 'auto') as ActorKind,
            classification: s.classification,
            retry: { maxAuto: 2, escalateTo: 'agent' as const },
            observedUrl: s.observedUrl,
            observedTitle: s.observedTitle,
        })),
        resolvedVars,
    };
}

function bindVarsToParams(
    params: Record<string, unknown>,
    vars: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
        out[k] = bindValue(v, vars);
    }
    return out;
}

function bindValue(val: unknown, vars: Record<string, unknown>): unknown {
    if (typeof val === 'string') {
        const trimmed = val.trim();
        // Whole-string binding — preserve native type
        for (const [k, v] of Object.entries(vars)) {
            if (trimmed === `{{ ${k} }}` || trimmed === `{{${k}}}`) return v;
        }
        // Partial substitution
        let out = val;
        for (const [k, v] of Object.entries(vars)) {
            out = (out as string)
                .replace(`{{ ${k} }}`, String(v))
                .replace(`{{${k}}}`, String(v));
        }
        return out;
    }
    if (Array.isArray(val)) return val.map((item) => bindValue(item, vars));
    if (val && typeof val === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
            out[k] = bindValue(v, vars);
        }
        return out;
    }
    return val;
}

function normalizeToolName(tool: string): string {
    return tool.replace('browser.', 'browser_');
}

async function getLastScreenshot(sessionId?: string): Promise<string | undefined> {
    if (!sessionId) return undefined;
    try {
        const result = await invoke<{ screenshot?: string }>('browser_rpc', {
            request: { method: 'browser.observe', params: { session_id: sessionId, include_screenshot: true } },
        });
        return result.screenshot;
    } catch {
        return undefined;
    }
}

async function verifyPostcondition(
    cond: Postcondition,
    rpcResult: Record<string, unknown>,
    params: Record<string, unknown>,
): Promise<boolean> {
    switch (cond.type) {
        case 'none':
            return true;

        case 'url_pattern': {
            const url = String(rpcResult.url ?? params.url ?? '');
            return url.includes(cond.value) || new RegExp(cond.value).test(url);
        }

        case 'text_contains': {
            const pageText = JSON.stringify(rpcResult);
            return pageText.includes(cond.value);
        }

        case 'selector_exists': {
            const sessionId = params.session_id as string | undefined;
            if (!sessionId) return false;
            try {
                await invoke('browser_rpc', {
                    request: {
                        method: 'browser.observe',
                        params: { session_id: sessionId, ready_selector: cond.value },
                    },
                });
                return true;
            } catch {
                return false;
            }
        }

        case 'variable_extracted':
            return rpcResult[cond.value] !== undefined && rpcResult[cond.value] !== null;

        default:
            return true;
    }
}

function extractOutput(step: NormalizedStep, result: Record<string, unknown>): unknown {
    if (!step.producesVariable) return undefined;
    const spec = (step as WorkflowStepV2).producesFrom;
    if (!spec) {
        // Best-effort: look for the variable name as a key, or check url
        return result[step.producesVariable] ?? extractFromUrl(String(result.url ?? ''), step.producesVariable);
    }
    switch (spec.from) {
        case 'url_regex': {
            const url = String(result.url ?? '');
            const match = url.match(new RegExp(spec.pattern));
            return match ? (match[spec.group ?? 1] ?? match[0]) : undefined;
        }
        case 'page_title':
            return result.title;
        case 'ax_selector':
            return result[spec.pattern];
        default:
            return undefined;
    }
}

function extractFromUrl(url: string, varName: string): string | undefined {
    // Common pattern: ticket IDs appear at the end of URLs like /browse/PROJ-123
    const match = url.match(/\/([A-Z]+-\d+)(?:[/?#]|$)/);
    if (match && (varName.includes('id') || varName.includes('ticket') || varName.includes('issue'))) {
        return match[1];
    }
    return undefined;
}

function emptyStepRun(stepId: string, index: number): WorkflowStepRun {
    return {
        stepId: stepId || String(index),
        status: 'pending',
        attempts: [],
        resolvedInputs: {},
        outputValue: undefined,
    };
}
