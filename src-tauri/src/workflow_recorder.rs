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
    pub tool: String,
    pub params: Value,
    pub actor: String, // "auto" | "agent" | "human"
    pub human_prompt: Option<String>,
    pub human_inputs: Option<Vec<HumanInput>>,
    pub requires_variables: Option<Vec<String>>,
    pub produces_variable: Option<String>,
    pub produces_from: Option<ProducesSpec>,
    pub postcondition: Option<Postcondition>,
    pub retry: RetryPolicy,
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
    pub variables: Vec<WorkflowVariable>,
    pub steps: Vec<WorkflowStepV2>,
}

// ── Run checkpoint ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepAttempt {
    pub n: u32,
    pub actor: String,
    pub started_at: String,
    pub error: Option<String>,
    pub screenshot_b64: Option<String>,
    pub agent_reasoning: Option<String>,
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

fn workflows_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(WORKFLOWS_DIR))
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
    fs::write(&path, serialized).await.map_err(|e| e.to_string())?;
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
    fs::write(&path, serialized).await.map_err(|e| e.to_string())?;
    Ok(definition)
}

// ── Run checkpoint commands (SQLite-backed) ─────────────────────────────────

/// Create a new run record and persist it via SQLite. Called at the start of every replay.
#[command]
pub async fn workflow_run_create(
    workflow_slug: String,
    resolved_vars: Value,
    step_count: usize,
    db: tauri::State<'_, crate::workflow_db::WorkflowDb>,
) -> Result<WorkflowRun, String> {
    db.create_run(&workflow_slug, &resolved_vars, step_count)
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
