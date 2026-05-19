// Workflow recorder — captures browser_rpc calls into a replayable file.
//
// Two schema versions coexist:
//   v1 — raw tool call tape, no intents, no actor model (backward compat)
//   v2 — intent-annotated, actor-aware, parameterized steps with postcondition
//        verification and a three-tier recovery model (auto → agent → human)
//
// Recording flow:
//   1. workflow_recording_start()  — begin capture
//   2. browser_rpc calls append steps automatically
//   3. workflow_recording_stop()   — returns raw v1 steps (no LLM yet)
//   4. [frontend calls workflow_enrich_recording() in workflow_enricher.rs]
//   5. workflow_recording_finalize() — saves reviewed v2 file to disk
//
// Workflows save to ~/.ittoolkit/workflows/*.workflow.json
// Run checkpoints save to ~/.ittoolkit/workflow-runs/*.run.json

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{command, AppHandle, Manager};
use tokio::fs;
use tokio::sync::Mutex;

const WORKFLOWS_DIR: &str = ".ittoolkit/workflows";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    /// JSON-RPC method, e.g. "browser.observe".
    pub tool: String,
    /// Params sent to the sidecar at record time. Replay binds
    /// `{{ name }}` substrings in string-typed values to caller-provided
    /// parameters.
    pub params: Value,
    /// "read" | "write" | "destructive" from browser_classify at record time.
    pub classification: String,
    /// Page URL observed when the step executed (best-effort).
    pub observed_url: Option<String>,
    pub observed_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFile {
    pub name: String,
    /// Slug used as the filename (kebab-case of name).
    pub slug: String,
    pub version: u32,
    pub created_at: String,
    /// Model that ran the original session — purely informational.
    pub model_used: Option<String>,
    /// Declared parameters: `[{ name, type, required }]`. Phase 1 keeps
    /// this loose — schema enforcement is M5+.
    pub parameters: Vec<WorkflowParameter>,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowParameter {
    pub name: String,
    pub r#type: String, // "string" | "number" | "boolean"
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub name: String,
    pub slug: String,
    pub description: Option<String>,
    pub schedule: Option<String>,
    pub created_at: String,
    pub step_count: usize,
    pub variable_count: usize,
    pub version: u32,
    pub path: String,
}

// ── v2 schema ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Postcondition {
    pub r#type: String, // "url_pattern" | "selector_exists" | "text_contains" | "variable_extracted" | "none"
    pub value: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_auto: u32,
    pub escalate_to: String, // "agent" | "human" | "abort"
    pub agent_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanInput {
    pub name: String,
    pub label: String,
    pub r#type: String, // "text" | "password" | "select" | "checkbox"
    pub options: Option<Vec<String>>,
    pub required: bool,
    pub sensitive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducesSpec {
    pub from: String, // "url_regex" | "ax_selector" | "page_title"
    pub pattern: String,
    pub group: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepV2 {
    pub id: String,
    pub intent: String,
    pub description: Option<String>,
    pub tool: String,
    pub params: Value,
    pub actor: String, // "auto" | "agent" | "human"
    pub run_if: Option<String>,
    pub human_prompt: Option<String>,
    pub human_inputs: Option<Vec<HumanInput>>,
    pub requires_variables: Option<Vec<String>>,
    pub produces_variable: Option<String>,
    pub produces_from: Option<ProducesSpec>,
    pub postcondition: Option<Postcondition>,
    pub retry: RetryPolicy,
    pub failure_hints: Option<Vec<String>>,
    // v1 compat
    pub classification: String,
    pub observed_url: Option<String>,
    pub observed_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVariable {
    pub name: String,
    pub r#type: String, // "string" | "number" | "boolean"
    pub source: String, // "human_input" | "conversation_context" | "literal" | "step_output"
    pub default_value: Option<String>,
    pub description: String,
    pub sensitive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFileV2 {
    pub version: u32, // always 2
    pub name: String,
    pub slug: String,
    pub description: String,
    pub goal: String,
    pub created_at: String,
    pub model_used: Option<String>,
    pub schedule: Option<String>,
    pub variables: Vec<WorkflowVariable>,
    pub steps: Vec<WorkflowStepV2>,
}

// ── Pending gate (sticky human gates) ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingGate {
    pub gate_type: String, // "human_input" | "human_intervention" | "approval"
    pub step_index: usize,
    pub prompt: String,
    pub inputs: Option<Value>, // serialized HumanInput[]
    pub metadata: Option<Value>, // extra info (agentReasoning, screenshot, risk, etc.)
    pub created_at: String,
}

// ── Run checkpoint ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub inference_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepAttempt {
    pub n: u32,
    pub actor: String,
    pub started_at: String,
    pub error: Option<String>,
    pub screenshot_b64: Option<String>,
    pub agent_reasoning: Option<String>,
    pub agent_model: Option<String>,
    pub agent_usage: Option<AgentUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepRun {
    pub step_id: String,
    pub status: String,
    pub attempts: Vec<StepAttempt>,
    pub resolved_inputs: Value,
    pub output_value: Option<Value>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub run_id: String,
    pub workflow_slug: String,
    pub started_at: String,
    pub status: String, // "running" | "paused" | "completed" | "failed" | "cancelled"
    pub resolved_vars: Value,
    pub step_runs: Vec<WorkflowStepRun>,
    pub paused_at_step: Option<usize>,
    pub pause_reason: Option<String>,
    pub gate_data: Option<PendingGate>,
    pub source_conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEvent {
    pub id: i64,
    pub run_id: String,
    pub step_index: Option<i64>,
    pub attempt_number: Option<i64>,
    pub event_type: String,
    #[serde(default)]
    pub event_data: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertTraceEvent {
    pub run_id: String,
    pub step_index: Option<i64>,
    pub attempt_number: Option<i64>,
    pub event_type: String,
    #[serde(default)]
    pub event_data: Value,
}

struct ActiveRecording {
    name: String,
    started_at: String,
    model_used: Option<String>,
    steps: Vec<WorkflowStep>,
}

#[derive(Default)]
pub struct WorkflowRecorder {
    active: Arc<Mutex<Option<ActiveRecording>>>,
}

impl WorkflowRecorder {
    pub async fn append(&self, step: WorkflowStep) {
        let mut guard = self.active.lock().await;
        if let Some(rec) = guard.as_mut() {
            rec.steps.push(step);
        }
    }
}

fn slugify(input: &str) -> String {
    let lower = input.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut prev_dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("workflow");
    }
    out
}

pub(crate) fn workflows_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(WORKFLOWS_DIR))
}

/// Atomically write a JSON-serializable value to a file.
/// Writes to `{path}.tmp` first, then renames → `{path}` — prevents partial/corrupt
/// workflow files if the process crashes mid-write (rename is atomic on same filesystem).
async fn atomic_write(path: &PathBuf, serialized: &str) -> Result<(), String> {
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, serialized)
        .await
        .map_err(|e| format!("failed to write temp file: {}", e))?;
    fs::rename(&tmp_path, path)
        .await
        .map_err(|e| format!("failed to rename temp file: {}", e))?;
    Ok(())
}

#[command]
pub async fn workflow_recording_start(
    name: String,
    model_used: Option<String>,
    recorder: tauri::State<'_, WorkflowRecorder>,
) -> Result<bool, String> {
    let mut guard = recorder.active.lock().await;
    if guard.is_some() {
        return Err("a recording is already in progress — stop it first".to_string());
    }
    *guard = Some(ActiveRecording {
        name,
        started_at: Utc::now().to_rfc3339(),
        model_used,
        steps: Vec::new(),
    });
    Ok(true)
}

#[command]
pub async fn workflow_recording_stop(
    recorder: tauri::State<'_, WorkflowRecorder>,
) -> Result<Option<WorkflowFile>, String> {
    let active = {
        let mut guard = recorder.active.lock().await;
        guard.take()
    };
    let Some(active) = active else {
        return Ok(None);
    };

    let slug = slugify(&active.name);
    let file = WorkflowFile {
        name: active.name,
        slug: slug.clone(),
        version: 1,
        created_at: active.started_at,
        model_used: active.model_used,
        parameters: Vec::new(),
        steps: active.steps,
    };

    let dir = workflows_dir()?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let mut path = dir.join(format!("{}.workflow.json", slug));
    // Avoid clobbering an existing workflow by adding a suffix.
    let mut suffix = 2u32;
    while path.exists() {
        path = dir.join(format!("{}-{}.workflow.json", slug, suffix));
        suffix += 1;
        if suffix > 99 {
            return Err("too many workflows with the same slug".to_string());
        }
    }
    let serialized = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    atomic_write(&path, &serialized).await?;
    Ok(Some(file))
}

#[command]
pub async fn workflow_recording_status(
    recorder: tauri::State<'_, WorkflowRecorder>,
) -> Result<Option<RecordingStatus>, String> {
    let guard = recorder.active.lock().await;
    Ok(guard.as_ref().map(|r| RecordingStatus {
        name: r.name.clone(),
        started_at: r.started_at.clone(),
        step_count: r.steps.len(),
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub name: String,
    pub started_at: String,
    pub step_count: usize,
}

#[command]
pub async fn workflow_list() -> Result<Vec<WorkflowSummary>, String> {
    let dir = workflows_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut read_dir = fs::read_dir(&dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = read_dir.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let body = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        // Try v2 first, fall back to v1.
        let summary = if let Ok(v2) = serde_json::from_str::<WorkflowFileV2>(&body) {
            WorkflowSummary {
                name: v2.name,
                slug: v2.slug,
                description: Some(v2.description),
                schedule: v2.schedule,
                created_at: v2.created_at,
                step_count: v2.steps.len(),
                variable_count: v2.variables.len(),
                version: 2,
                path: path.to_string_lossy().to_string(),
            }
        } else if let Ok(v1) = serde_json::from_str::<WorkflowFile>(&body) {
            WorkflowSummary {
                name: v1.name,
                slug: v1.slug,
                description: None,
                schedule: None,
                created_at: v1.created_at,
                step_count: v1.steps.len(),
                variable_count: v1.parameters.len(),
                version: 1,
                path: path.to_string_lossy().to_string(),
            }
        } else {
            continue; // malformed — skip silently
        };
        out.push(summary);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Save a reviewed v2 workflow definition to disk.
/// Called by the WorkflowRecordingReview UI after the user has confirmed
/// intents, actor classifications, and variable declarations.
#[command]
pub async fn workflow_recording_finalize(
    definition: WorkflowFileV2,
) -> Result<WorkflowFileV2, String> {
    let dir = workflows_dir()?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let mut path = dir.join(format!("{}.workflow.json", definition.slug));
    let mut suffix = 2u32;
    while path.exists() {
        path = dir.join(format!("{}-{}.workflow.json", definition.slug, suffix));
        suffix += 1;
        if suffix > 99 {
            return Err("too many workflows with the same slug".to_string());
        }
    }
    let serialized = serde_json::to_string_pretty(&definition).map_err(|e| e.to_string())?;
    atomic_write(&path, &serialized).await?;
    Ok(definition)
}

// ── Run checkpoint commands (SQLite-backed) ─────────────────────────────────

/// Create a new run record and persist it via SQLite. Called at the start of every replay.
#[command]
pub async fn workflow_run_create(
    workflow_slug: String,
    resolved_vars: Value,
    step_count: usize,
    source_conversation_id: Option<String>,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<WorkflowRun, String> {
    // Validate that the workflow file exists before creating a run.
    let wf_path = workflows_dir()?.join(format!("{}.workflow.json", &workflow_slug));
    if !fs::metadata(&wf_path).await.map(|m| m.is_file()).unwrap_or(false) {
        return Err(format!(
            "Workflow '{}' not found — expected file at {}",
            workflow_slug,
            wf_path.display()
        ));
    }
    db.create_run(&workflow_slug, &resolved_vars, step_count, source_conversation_id.as_deref())
}

/// Insert a trace event into the database for a workflow run.
#[command]
pub async fn workflow_trace_event_insert(
    event: InsertTraceEvent,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<i64, String> {
    db.insert_trace_event(&event)
}

/// Query trace events for a given workflow run.
#[command]
pub async fn workflow_trace_events_list(
    run_id: String,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<Vec<TraceEvent>, String> {
    db.query_trace_events(&run_id)
}

/// Checkpoint one step's runtime state via SQLite. Called after every step transition.
/// Uses an upsert into workflow_step_runs — O(1) instead of O(file_size).
#[command]
pub async fn workflow_run_checkpoint(
    run_id: String,
    step_index: usize,
    step_run: WorkflowStepRun,
    paused_at_step: Option<usize>,
    pause_reason: Option<String>,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    db.checkpoint_step(&run_id, step_index, &step_run, paused_at_step, pause_reason)
}

/// Persist a pending gate and mark the run as paused.
/// Called by the engine when a human gate triggers to make it survive app restart.
#[command]
pub async fn workflow_run_pause_for_gate(
    run_id: String,
    gate: PendingGate,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    db.save_pending_gate(&run_id, &gate)
}

/// Clear the pending gate and mark the run as running again (resolved by user).
#[command]
pub async fn workflow_run_resolve_gate(
    run_id: String,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    db.clear_pending_gate(&run_id)
}

/// Mark a run as completed/failed/cancelled via SQLite.
#[command]
pub async fn workflow_run_complete(
    run_id: String,
    status: String,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    db.complete_run(&run_id, &status)
}

/// List all runs that are in "running" or "paused" state (incomplete) via SQLite.
/// Called on app startup to surface resumable runs in the UI.
#[command]
pub async fn workflow_run_list_incomplete(
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<Vec<WorkflowRun>, String> {
    db.list_incomplete_runs()
}

/// Overwrite an existing workflow definition file with updated content.
/// Used by the WorkflowEditor to persist edits in-place.
#[command]
pub async fn workflow_update(definition: WorkflowFileV2) -> Result<WorkflowFileV2, String> {
    let dir = workflows_dir()?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.workflow.json", definition.slug));
    let serialized = serde_json::to_string_pretty(&definition).map_err(|e| e.to_string())?;
    atomic_write(&path, &serialized).await?;
    Ok(definition)
}

#[command]
pub async fn workflow_load(slug: String) -> Result<serde_json::Value, String> {
    let dir = workflows_dir()?;
    let path = dir.join(format!("{}.workflow.json", slug));
    if !path.exists() {
        return Err(format!("workflow not found: {}", slug));
    }
    let body = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    // Return raw JSON so both v1 and v2 files pass through verbatim.
    // The TypeScript side uses the `version` field to dispatch (isV2 guard).
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

#[command]
pub async fn workflow_delete(slug: String) -> Result<bool, String> {
    let dir = workflows_dir()?;
    let path = dir.join(format!("{}.workflow.json", slug));
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    Ok(true)
}

/// Replay engine. Streams ReplayEvents via Tauri event `workflow-replay-event`.
/// Per-step approval enforcement is the UI's job — this engine just runs
/// the steps and re-classifies each. The UI surfaces approval prompts for
/// write/destructive steps before allowing the next invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayEvent {
    pub step_index: usize,
    pub status: String, // "started" | "done" | "error" | "needs_approval"
    pub method: Option<String>,
    pub classification: Option<String>,
    pub error: Option<String>,
}

fn bind_params(value: &Value, params: &serde_json::Map<String, Value>) -> Value {
    match value {
        Value::String(s) => {
            // Replace `{{ name }}` (with optional whitespace) with the bound
            // parameter value. If the entire string is exactly `{{ name }}`
            // (possibly with spaces), we preserve the parameter's native type
            // (bool, number) instead of stringifying — this prevents browser.open's
            // `headed: true` from arriving as the string "true" which the sidecar
            // would not accept as a boolean.
            for (k, v) in params {
                let needle_a = format!("{{{{ {} }}}}", k);
                let needle_b = format!("{{{{{}}}}}", k);
                if s.trim() == needle_a.trim() || s.trim() == needle_b.trim() {
                    return v.clone(); // preserve native type
                }
            }
            // Partial substitution: replacement is always a string form.
            let mut out = s.clone();
            for (k, v) in params {
                let needle_a = format!("{{{{ {} }}}}", k);
                let needle_b = format!("{{{{{}}}}}", k);
                let replacement = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                out = out.replace(&needle_a, &replacement);
                out = out.replace(&needle_b, &replacement);
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|i| bind_params(i, params)).collect()),
        Value::Object(obj) => {
            let mut new = serde_json::Map::with_capacity(obj.len());
            for (k, v) in obj {
                new.insert(k.clone(), bind_params(v, params));
            }
            Value::Object(new)
        }
        other => other.clone(),
    }
}

#[command]
pub async fn workflow_replay_bind(
    slug: String,
    parameters: serde_json::Map<String, Value>,
) -> Result<Vec<WorkflowStep>, String> {
    // Loads the workflow and returns the parameter-bound step list so the
    // UI / chat can iterate and dispatch through browser_rpc with the
    // same approval flow shell commands already use. Keeping replay
    // single-stepped in the caller (rather than a fire-and-forget Rust
    // task) lets us reuse the existing risk-tier UI plumbing.
    let dir = workflows_dir()?;
    let path = dir.join(format!("{}.workflow.json", slug));
    if !path.exists() {
        return Err(format!("workflow not found: {}", slug));
    }
    let body = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    // Try v1 struct first; fall back to raw JSON step extraction for v2 files.
    if let Ok(file) = serde_json::from_str::<WorkflowFile>(&body) {
        return Ok(file
            .steps
            .into_iter()
            .map(|step| WorkflowStep {
                tool: step.tool,
                params: bind_params(&step.params, &parameters),
                classification: step.classification,
                observed_url: step.observed_url,
                observed_title: step.observed_title,
            })
            .collect());
    }
    // v2 file — extract steps from raw JSON
    let raw: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let steps = raw["steps"].as_array().ok_or("v2 workflow missing steps array")?;
    Ok(steps
        .iter()
        .filter_map(|s| {
            Some(WorkflowStep {
                tool: s["tool"].as_str()?.to_string(),
                params: bind_params(&s["params"], &parameters),
                classification: s["classification"].as_str().unwrap_or("read").to_string(),
                observed_url: s["observedUrl"].as_str().map(String::from),
                observed_title: s["observedTitle"].as_str().map(String::from),
            })
        })
        .collect())
}

/// Seed bundled canonical workflows to `~/.ittoolkit/workflows/` on first run.
/// Uses merge-only semantics: if the destination file already exists (user edited
/// or re-recorded it), we skip it — we never overwrite user work.
pub fn seed_default_workflows(app: &AppHandle) -> Result<(), String> {
    use tauri::path::BaseDirectory;
    let dst_dir = workflows_dir()?;
    let src_dir = app
        .path()
        .resolve("resources/default-workflows", BaseDirectory::Resource)
        .or_else(|_| {
            app.path()
                .resolve("default-workflows", BaseDirectory::Resource)
        })
        .map_err(|e| format!("Failed to resolve default-workflows resource: {}", e))?;

    if !src_dir.exists() {
        log::warn!("Default workflows resource dir not found at {:?}", src_dir);
        return Ok(());
    }

    if let Err(e) = std::fs::create_dir_all(&dst_dir) {
        return Err(format!("Failed to create workflows dir: {}", e));
    }

    let entries = std::fs::read_dir(&src_dir)
        .map_err(|e| format!("Failed to read default-workflows dir: {}", e))?;
    for entry in entries.flatten() {
        let src = entry.path();
        if !src.extension().map_or(false, |ext| ext == "json") {
            continue;
        }
        let dst = dst_dir.join(entry.file_name());
        if dst.exists() {
            // Never overwrite — preserve user-recorded or user-edited workflows.
            continue;
        }
        if let Err(e) = std::fs::copy(&src, &dst) {
            log::warn!("Failed to seed workflow {:?}: {}", src.file_name().unwrap_or_default(), e);
        } else {
            log::debug!("Seeded default workflow: {:?}", dst.file_name().unwrap_or_default());
        }
    }
    Ok(())
}

// ── Schema introspection (Agent Harness Phase A) ─────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSchema {
    pub version: u32,
    pub available_tools: Vec<ToolSchema>,
    pub actor_types: Vec<SchemaEntry>,
    pub variable_sources: Vec<SchemaEntry>,
    pub classifications: Vec<SchemaEntry>,
    pub retry_config: RetryConfigSchema,
    pub postcondition_types: Vec<SchemaEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub category: String,
    pub params: Vec<ParamSchema>,
    pub supported_actors: Vec<String>,
    pub requires_open_session: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamSchema {
    pub name: String,
    pub param_type: String,
    pub description: String,
    pub required: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEntry {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryConfigSchema {
    pub max_auto_range: (u32, u32),
    pub escalate_to: Vec<String>,
}

/// Return the current workflow schema for the agent to reference at runtime.
/// Replaces the hardcoded schema section in SKILL.md — always up to date.
#[command]
pub async fn get_workflow_schema() -> WorkflowSchema {
    WorkflowSchema {
        version: 2,
        available_tools: vec![
            ToolSchema {
                name: "browser.open".into(),
                description: "Open a browser session. MUST be the first step in every workflow that uses browser tools.".into(),
                category: "Browser".into(),
                params: vec![
                    ParamSchema { name: "session_id".into(), param_type: "string".into(), description: "Unique session identifier".into(), required: true, default_value: None },
                    ParamSchema { name: "headed".into(), param_type: "boolean".into(), description: "Show a visible window (vs headless)".into(), required: false, default_value: Some("false".into()) },
                    ParamSchema { name: "profile".into(), param_type: "string".into(), description: "ephemeral (no cookies survive) or persistent (cookies saved)".into(), required: false, default_value: Some("ephemeral".into()) },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: false,
            },
            ToolSchema {
                name: "browser.navigate".into(),
                description: "Navigate to a URL in an open session.".into(),
                category: "Browser".into(),
                params: vec![
                    ParamSchema { name: "session_id".into(), param_type: "string".into(), description: "Session identifier".into(), required: true, default_value: None },
                    ParamSchema { name: "url".into(), param_type: "string".into(), description: "Full URL to navigate to".into(), required: true, default_value: None },
                    ParamSchema { name: "wait_until".into(), param_type: "string".into(), description: "When to consider navigation complete: load, domcontentloaded, networkidle".into(), required: false, default_value: Some("load".into()) },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: true,
            },
            ToolSchema {
                name: "browser.observe".into(),
                description: "Capture the current page AX tree and a screenshot.".into(),
                category: "Browser".into(),
                params: vec![
                    ParamSchema { name: "session_id".into(), param_type: "string".into(), description: "Session identifier".into(), required: true, default_value: None },
                    ParamSchema { name: "include_screenshot".into(), param_type: "boolean".into(), description: "Include a base64 screenshot in the result".into(), required: false, default_value: Some("true".into()) },
                ],
                supported_actors: vec!["auto".into(), "agent".into(), "human".into()],
                requires_open_session: true,
            },
            ToolSchema {
                name: "browser.act".into(),
                description: "Click, type, select, hover, scroll, or press a key on an element identified by AX index.".into(),
                category: "Browser".into(),
                params: vec![
                    ParamSchema { name: "session_id".into(), param_type: "string".into(), description: "Session identifier".into(), required: true, default_value: None },
                    ParamSchema { name: "action".into(), param_type: "string".into(), description: "What to do: click, type, select, hover, scroll, press".into(), required: true, default_value: None },
                    ParamSchema { name: "index".into(), param_type: "number".into(), description: "AX index of the element (ignored for actor=agent, which re-observes live)".into(), required: false, default_value: None },
                    ParamSchema { name: "text".into(), param_type: "string".into(), description: "Text to type or key to press (e.g. Enter)".into(), required: false, default_value: None },
                    ParamSchema { name: "submit".into(), param_type: "boolean".into(), description: "Submit the form after typing".into(), required: false, default_value: None },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: true,
            },
            ToolSchema {
                name: "browser.extract".into(),
                description: "Extract text content from an element by AX index or role+name.".into(),
                category: "Browser".into(),
                params: vec![
                    ParamSchema { name: "session_id".into(), param_type: "string".into(), description: "Session identifier".into(), required: true, default_value: None },
                    ParamSchema { name: "index".into(), param_type: "number".into(), description: "AX index of the element".into(), required: false, default_value: None },
                    ParamSchema { name: "attribute".into(), param_type: "string".into(), description: "Attribute to extract (e.g. href, data-id)".into(), required: false, default_value: None },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: true,
            },
            ToolSchema {
                name: "browser.close".into(),
                description: "Close a browser session and release resources.".into(),
                category: "Browser".into(),
                params: vec![
                    ParamSchema { name: "session_id".into(), param_type: "string".into(), description: "Session identifier".into(), required: true, default_value: None },
                ],
                supported_actors: vec!["auto".into()],
                requires_open_session: true,
            },
            // ── Non-browser tools (unified activity system) ────────────
            ToolSchema {
                name: "shell.exec".into(),
                description: "Execute a shell command on the local system. Use for system administration tasks: scripts, queries, file operations.".into(),
                category: "System".into(),
                params: vec![
                    ParamSchema { name: "command".into(), param_type: "string".into(), description: "The shell command to execute".into(), required: true, default_value: None },
                    ParamSchema { name: "working_dir".into(), param_type: "string".into(), description: "Working directory for the command".into(), required: false, default_value: None },
                    ParamSchema { name: "timeout_secs".into(), param_type: "number".into(), description: "Timeout in seconds".into(), required: false, default_value: Some("30".into()) },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: false,
            },
            ToolSchema {
                name: "http.request".into(),
                description: "Make an HTTP request to an API endpoint. Use for REST API calls, webhooks, web service interactions.".into(),
                category: "System".into(),
                params: vec![
                    ParamSchema { name: "method".into(), param_type: "string".into(), description: "HTTP method: GET, POST, PUT, PATCH, DELETE".into(), required: true, default_value: None },
                    ParamSchema { name: "url".into(), param_type: "string".into(), description: "Request URL".into(), required: true, default_value: None },
                    ParamSchema { name: "headers".into(), param_type: "object".into(), description: "HTTP headers as key-value pairs".into(), required: false, default_value: None },
                    ParamSchema { name: "body".into(), param_type: "object".into(), description: "Request body (JSON object)".into(), required: false, default_value: None },
                    ParamSchema { name: "timeout_secs".into(), param_type: "number".into(), description: "Timeout in seconds".into(), required: false, default_value: Some("30".into()) },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: false,
            },
            ToolSchema {
                name: "workflow.run".into(),
                description: "Run another saved workflow/activity by slug. Use for composing multi-step activities from reusable workflows.".into(),
                category: "Composition".into(),
                params: vec![
                    ParamSchema { name: "slug".into(), param_type: "string".into(), description: "Slug of the workflow/activity to run".into(), required: true, default_value: None },
                    ParamSchema { name: "variables".into(), param_type: "object".into(), description: "Variable overrides passed to the child workflow".into(), required: false, default_value: None },
                ],
                supported_actors: vec!["auto".into(), "agent".into()],
                requires_open_session: false,
            },
            ToolSchema {
                name: "human.gate".into(),
                description: "Pause execution for human interaction: review, confirmation, manual steps. Use when the automation needs judgement or physical-world action.".into(),
                category: "Human".into(),
                params: vec![
                    ParamSchema { name: "prompt".into(), param_type: "string".into(), description: "Instructions for the human — what to do or review".into(), required: true, default_value: None },
                    ParamSchema { name: "inputs".into(), param_type: "array".into(), description: "Structured form fields: [{name, label, type, required}]".into(), required: false, default_value: None },
                ],
                supported_actors: vec!["human".into()],
                requires_open_session: false,
            },
            ToolSchema {
                name: "agent.task".into(),
                description: "Delegate an open-ended task to the AI agent. Use when the next action depends on reading, reasoning, or deciding based on previous results.".into(),
                category: "Human".into(),
                params: vec![
                    ParamSchema { name: "instructions".into(), param_type: "string".into(), description: "What the agent should do — plain language task description".into(), required: true, default_value: None },
                    ParamSchema { name: "context".into(), param_type: "string".into(), description: "Optional context from previous steps".into(), required: false, default_value: None },
                ],
                supported_actors: vec!["agent".into()],
                requires_open_session: false,
            },
        ],
        actor_types: vec![
            SchemaEntry { name: "auto".into(), description: "Deterministic execution — no LLM. Retries up to maxAuto times on failure.".into() },
            SchemaEntry { name: "agent".into(), description: "AI reads the live page and decides how to act. Use when element indices or values are not known in advance.".into() },
            SchemaEntry { name: "human".into(), description: "Pauses execution and waits for the user to act in the browser or fill a form. Use for login, MFA, review-before-submit.".into() },
        ],
        variable_sources: vec![
            SchemaEntry { name: "human_input".into(), description: "User fills it in the Run panel before starting. Use for values the automation cannot guess.".into() },
            SchemaEntry { name: "conversation_context".into(), description: "Agent infers from the chat conversation. Use for things the user already mentioned.".into() },
            SchemaEntry { name: "literal".into(), description: "Fixed value, never changes.".into() },
            SchemaEntry { name: "step_output".into(), description: "Produced by an earlier step (e.g. ticket ID extracted from URL).".into() },
        ],
        classifications: vec![
            SchemaEntry { name: "read".into(), description: "Only reads or observes — no state change. No approval required.".into() },
            SchemaEntry { name: "write".into(), description: "Creates, updates, posts, submits — changes state. Requires user approval.".into() },
            SchemaEntry { name: "destructive".into(), description: "Deletes, resets, removes access. Requires red-highlighted approval.".into() },
        ],
        retry_config: RetryConfigSchema {
            max_auto_range: (0, 10),
            escalate_to: vec!["agent".into(), "human".into(), "abort".into()],
        },
        postcondition_types: vec![
            SchemaEntry { name: "url_pattern".into(), description: "Match the current URL against a regex pattern.".into() },
            SchemaEntry { name: "selector_exists".into(), description: "Check if an element matching a CSS selector exists in the DOM.".into() },
            SchemaEntry { name: "text_contains".into(), description: "Check if the page body contains a specific text string.".into() },
            SchemaEntry { name: "none".into(), description: "No postcondition verification.".into() },
        ],
    }
}

// ── Schedule data types (Phase 1) ───────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSchedule {
    pub id: i64,
    pub workflow_slug: String,
    pub cron_expression: String,
    pub variables: Value,
    pub enabled: bool,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellExecResponse {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestResponse {
    pub status: u16,
    pub status_text: String,
    pub body: String,
}

// ── Non-browser executor commands (Agent Harness Phase 1) ──

/// Execute a shell command for a workflow step. Unlike execute_command,
/// this bypasses the interactive security gate (the user already approved
/// the workflow). Returns stdout, stderr, and exit code.
#[command]
pub async fn workflow_shell_exec(
    command: String,
    working_dir: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<ShellExecResponse, String> {
    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return Err("shell.exec: command cannot be empty".into());
    }

    let work_dir = match working_dir {
        Some(ref d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?,
    };

    let timeout_duration = std::time::Duration::from_secs(
        timeout_secs.unwrap_or(30).min(300),
    );

    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .current_dir(&work_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let child = std::sync::Arc::new(tokio::sync::Mutex::new(Some(child)));
    let child_for_task = child.clone();

    let result = tokio::time::timeout(timeout_duration, async move {
        let mut guard = child_for_task.lock().await;
        let child_opt = guard.as_mut()
            .ok_or_else(|| "Child process unavailable".to_string())?;

        let mut child_stdout = child_opt.stdout.take();
        let mut child_stderr = child_opt.stderr.take();

        let status = child_opt
            .wait()
            .await
            .map_err(|e| format!("Failed to wait for command: {}", e))?;

        let mut stdout = String::new();
        if let Some(out) = child_stdout.as_mut() {
            tokio::io::AsyncReadExt::read_to_string(out, &mut stdout).await.ok();
        }

        let mut stderr = String::new();
        if let Some(err) = child_stderr.as_mut() {
            tokio::io::AsyncReadExt::read_to_string(err, &mut stderr).await.ok();
        }

        let exit_code = status.code().unwrap_or(-1);

        Ok::<_, String>(ShellExecResponse {
            stdout: if stdout.len() > 10_000 {
                format!("{}\n\n... (output truncated)", &stdout[..10_000])
            } else { stdout },
            stderr: if stderr.len() > 10_000 {
                format!("{}\n\n... (output truncated)", &stderr[..10_000])
            } else { stderr },
            exit_code,
            timed_out: false,
        })
    })
    .await;

    match result {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let mut guard = child.lock().await;
            if let Some(c) = guard.as_mut() {
                let _ = c.kill().await;
                let _ = c.wait().await;
            }
            Ok(ShellExecResponse {
                stdout: String::new(),
                stderr: format!("Command timed out after {:?}", timeout_duration),
                exit_code: -1,
                timed_out: true,
            })
        }
    }
}

/// Make an HTTP request from a workflow step. Uses reqwest (already in deps).
#[command]
pub async fn workflow_http_request(
    method: String,
    url: String,
    headers: Option<Vec<(String, String)>>,
    body: Option<Value>,
    timeout_secs: Option<u64>,
) -> Result<HttpRequestResponse, String> {
    let method_upper = method.to_uppercase();
    let http_method = match method_upper.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(format!("http.request: invalid method '{}'", method)),
    };

    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("http.request: url must start with http:// or https://".into());
    }

    let timeout_duration = std::time::Duration::from_secs(
        timeout_secs.unwrap_or(30).min(120),
    );

    let client = reqwest::Client::builder()
        .timeout(timeout_duration)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut req = client.request(http_method, &url);

    if let Some(ref h) = headers {
        for (key, val) in h {
            req = req.header(key.as_str(), val.as_str());
        }
    }

    // Default Content-Type for JSON body
    if body.is_some() && headers.as_ref().map_or(true, |h| !h.iter().any(|(k, _)| k.to_lowercase() == "content-type")) {
        req = req.header("Content-Type", "application/json");
    }

    if let Some(b) = body {
        req = req.json(&b);
    }

    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("http.request: request timed out after {:?}", timeout_duration)
        } else if e.is_connect() {
            format!("http.request: connection failed: {}", e)
        } else {
            format!("http.request: request failed: {}", e)
        }
    })?;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("Unknown").to_string();
    let body_bytes = response.bytes().await.map_err(|e| format!("http.request: failed to read response body: {}", e))?;
    let body_str = String::from_utf8_lossy(&body_bytes).to_string();
    let body = if body_str.len() > 50_000 {
        format!("{}\n\n... (response truncated, {} total bytes)", &body_str[..50_000], body_bytes.len())
    } else { body_str };

    Ok(HttpRequestResponse {
        status: status.as_u16(),
        status_text,
        body,
    })
}

// ── Schedule management commands ────────────────────────────

#[command]
pub async fn workflow_schedule_set(
    workflow_slug: String,
    cron_expression: String,
    variables: Option<Value>,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    // Validate cron expression before saving
    cron::Schedule::from_str(&cron_expression)
        .map_err(|e| format!("Invalid cron expression '{}': {}", cron_expression, e))?;
    db.set_schedule(&workflow_slug, &cron_expression, &variables.unwrap_or(Value::Object(Default::default())))?;

    // Also update the schedule field in the workflow JSON file
    let dir = workflows_dir()?;
    let path = dir.join(format!("{}.workflow.json", &workflow_slug));
    if path.exists() {
        let content = tokio::fs::read_to_string(&path).await
            .map_err(|e| format!("Failed to read workflow file: {}", e))?;
        let mut wf: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse workflow: {}", e))?;
        if let Some(obj) = wf.as_object_mut() {
            if cron_expression.is_empty() {
                obj.remove("schedule");
            } else {
                obj.insert("schedule".into(), Value::String(cron_expression.clone()));
            }
        }
        let new_content = serde_json::to_string_pretty(&wf)
            .map_err(|e| format!("Failed to serialize workflow: {}", e))?;
        atomic_write(&path, &new_content).await?;
    }

    Ok(())
}

#[command]
pub async fn workflow_schedule_get(
    workflow_slug: String,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<Option<WorkflowSchedule>, String> {
    db.get_schedule(&workflow_slug)
}

#[command]
pub async fn workflow_schedule_list(
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<Vec<WorkflowSchedule>, String> {
    db.list_schedules()
}

#[command]
pub async fn workflow_schedule_delete(
    workflow_slug: String,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    db.delete_schedule(&workflow_slug)?;

    // Remove the schedule field from the workflow JSON file
    let dir = workflows_dir()?;
    let path = dir.join(format!("{}.workflow.json", &workflow_slug));
    if path.exists() {
        let content = tokio::fs::read_to_string(&path).await
            .map_err(|e| format!("Failed to read workflow file: {}", e))?;
        let mut wf: Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse workflow: {}", e))?;
        if let Some(obj) = wf.as_object_mut() {
            obj.remove("schedule");
        }
        let new_content = serde_json::to_string_pretty(&wf)
            .map_err(|e| format!("Failed to serialize workflow: {}", e))?;
        atomic_write(&path, &new_content).await?;
    }

    Ok(())
}

#[command]
pub async fn workflow_schedule_toggle(
    workflow_slug: String,
    enabled: bool,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<(), String> {
    db.toggle_schedule(&workflow_slug, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slugify_handles_specials() {
        assert_eq!(slugify("Okta unlock user"), "okta-unlock-user");
        assert_eq!(slugify("  Foo!! Bar  "), "foo-bar");
        assert_eq!(slugify(""), "workflow");
    }

    #[test]
    fn bind_params_replaces_double_brace() {
        let template = json!({ "url": "https://x.com/{{ user }}/profile", "n": 3 });
        let mut params = serde_json::Map::new();
        params.insert("user".to_string(), Value::String("ada".to_string()));
        let bound = bind_params(&template, &params);
        assert_eq!(bound["url"], "https://x.com/ada/profile");
        assert_eq!(bound["n"], 3);
    }

    #[test]
    fn bind_params_tolerates_no_whitespace() {
        let template = json!("{{name}}-suffix");
        let mut params = serde_json::Map::new();
        params.insert("name".to_string(), Value::String("ittk".to_string()));
        assert_eq!(bind_params(&template, &params), Value::String("ittk-suffix".to_string()));
    }

    #[test]
    fn bind_params_preserves_bool_native_type() {
        // A string that is EXACTLY `{{ headed }}` should resolve to the bool
        // Value, not the string "true". browser.open's `headed` flag is a
        // boolean; arriving as "true" would fail the sidecar's type check.
        let template = json!({ "headed": "{{ headed }}", "session_id": "s1" });
        let mut params = serde_json::Map::new();
        params.insert("headed".to_string(), Value::Bool(true));
        let bound = bind_params(&template, &params);
        assert_eq!(bound["headed"], Value::Bool(true));
        assert_eq!(bound["session_id"], json!("s1")); // untouched
    }

    #[test]
    fn bind_params_preserves_number_native_type() {
        let template = json!({ "timeout": "{{ timeout_ms }}" });
        let mut params = serde_json::Map::new();
        params.insert("timeout_ms".to_string(), json!(5000));
        let bound = bind_params(&template, &params);
        assert_eq!(bound["timeout"], json!(5000));
    }

    #[test]
    fn bind_params_partial_string_still_stringifies() {
        // If the template has MORE text around the placeholder, we must
        // stringify even for bool/number — there's no other sensible result.
        let template = json!("prefix-{{ flag }}-suffix");
        let mut params = serde_json::Map::new();
        params.insert("flag".to_string(), Value::Bool(true));
        assert_eq!(bind_params(&template, &params), Value::String("prefix-true-suffix".to_string()));
    }
}
