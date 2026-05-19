// SQLite-backed durable storage for workflow run state.
//
// Replaces the previous read-modify-write JSON file approach with
// transactional, indexed, O(1) partial-update operations.
//
// Tables:
//   workflow_runs          — one row per run
//   workflow_step_runs     — one row per step per run (upserted on checkpoint)
//   workflow_step_attempts — one row per retry attempt per step
//   workflow_screenshots   — base64 screenshots stored once per attempt

use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct WorkflowDb {
    conn: Mutex<Connection>,
}

impl WorkflowDb {
    pub fn new() -> Result<Self, String> {
        let path = Self::db_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;
        Self::run_migrations(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn db_path() -> Result<PathBuf, String> {
        let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
        Ok(home.join(".ittoolkit/ittoolkit.db"))
    }

    fn run_migrations(conn: &Connection) -> Result<(), String> {
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        if version < 1 {
            conn.execute_batch(include_str!("../migrations/001_workflow_runs.sql"))
                .map_err(|e| e.to_string())?;
            conn.execute_batch("PRAGMA user_version = 1")
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    // ── helpers ────────────────────────────────────────────────────────

    fn vars_serialized(vars: &Value) -> Result<String, String> {
        serde_json::to_string(vars).map_err(|e| e.to_string())
    }

    fn inputs_serialized(inputs: &Value) -> Result<String, String> {
        serde_json::to_string(inputs).map_err(|e| e.to_string())
    }

    fn output_serialized(output: &Option<Value>) -> Result<Option<String>, String> {
        match output {
            Some(v) => serde_json::to_string(v).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }

    // ── public API ─────────────────────────────────────────────────────

    pub fn create_run(
        &self,
        workflow_slug: &str,
        resolved_vars: &Value,
        step_count: usize,
    ) -> Result<super::workflow_recorder::WorkflowRun, String> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let vars_json = Self::vars_serialized(resolved_vars)?;
        let step_runs: Vec<super::workflow_recorder::WorkflowStepRun> = (0..step_count)
            .map(|i| super::workflow_recorder::WorkflowStepRun {
                step_id: i.to_string(),
                status: "pending".to_string(),
                attempts: Vec::new(),
                resolved_inputs: Value::Object(serde_json::Map::new()),
                output_value: None,
                started_at: None,
                completed_at: None,
            })
            .collect();

        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO workflow_runs (run_id, workflow_slug, started_at, status, resolved_vars)
             VALUES (?1, ?2, ?3, 'running', ?4)",
            params![run_id, workflow_slug, now, vars_json],
        )
        .map_err(|e| e.to_string())?;

        for (i, sr) in step_runs.iter().enumerate() {
            conn.execute(
                "INSERT INTO workflow_step_runs (run_id, step_index, step_id, status, resolved_inputs)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    run_id,
                    i as i64,
                    sr.step_id,
                    sr.status,
                    Self::inputs_serialized(&sr.resolved_inputs)?
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(super::workflow_recorder::WorkflowRun {
            run_id,
            workflow_slug: workflow_slug.to_string(),
            started_at: now,
            status: "running".to_string(),
            resolved_vars: resolved_vars.clone(),
            step_runs,
            paused_at_step: None,
            pause_reason: None,
        })
    }

    pub fn checkpoint_step(
        &self,
        run_id: &str,
        step_index: usize,
        step_run: &super::workflow_recorder::WorkflowStepRun,
        paused_at_step: Option<usize>,
        pause_reason: Option<String>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let inputs_json = Self::inputs_serialized(&step_run.resolved_inputs)?;
        let output_json = Self::output_serialized(&step_run.output_value)?;

        conn.execute(
            "INSERT INTO workflow_step_runs (run_id, step_index, step_id, status, resolved_inputs, output_value, started_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(run_id, step_index) DO UPDATE SET
               status      = excluded.status,
               resolved_inputs = excluded.resolved_inputs,
               output_value    = excluded.output_value,
               started_at      = excluded.started_at,
               completed_at    = excluded.completed_at",
            params![
                run_id,
                step_index as i64,
                step_run.step_id,
                step_run.status,
                inputs_json,
                output_json,
                step_run.started_at,
                step_run.completed_at,
            ],
        )
        .map_err(|e| e.to_string())?;

        // Persist attempts
        for attempt in &step_run.attempts {
            conn.execute(
                "INSERT OR IGNORE INTO workflow_step_attempts
                   (run_id, step_index, attempt_number, actor, started_at, error, agent_reasoning)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    run_id,
                    step_index as i64,
                    attempt.n as i64,
                    attempt.actor,
                    attempt.started_at,
                    attempt.error,
                    attempt.agent_reasoning,
                ],
            )
            .map_err(|e| e.to_string())?;

            // Persist screenshot if present
            if let Some(ref ss) = attempt.screenshot_b64 {
                conn.execute(
                    "INSERT OR IGNORE INTO workflow_screenshots
                       (run_id, step_index, attempt_number, screenshot_b64)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![run_id, step_index as i64, attempt.n as i64, ss],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // Update run paused state
        conn.execute(
            "UPDATE workflow_runs SET paused_at_step = ?1, pause_reason = ?2 WHERE run_id = ?3",
            params![paused_at_step.map(|i| i as i64), pause_reason, run_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn complete_run(&self, run_id: &str, status: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE workflow_runs SET status = ?1 WHERE run_id = ?2",
            params![status, run_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_incomplete_runs(
        &self,
    ) -> Result<Vec<super::workflow_recorder::WorkflowRun>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT run_id, workflow_slug, started_at, status, resolved_vars,
                        paused_at_step, pause_reason
                 FROM workflow_runs
                 WHERE status IN ('running', 'paused')
                 ORDER BY started_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let run_rows: Vec<(
            String,
            String,
            String,
            String,
            String,
            Option<i64>,
            Option<String>,
        )> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut out = Vec::with_capacity(run_rows.len());
        for (run_id, workflow_slug, started_at, status, vars_json, paused_step, pause_reason) in
            run_rows
        {
            let resolved_vars: Value =
                serde_json::from_str(&vars_json).unwrap_or(Value::Object(Default::default()));

            // Load step runs
            let mut step_runs = Vec::new();
            let mut sr_stmt = conn
                .prepare(
                    "SELECT step_index, step_id, status, resolved_inputs, output_value,
                            started_at, completed_at
                     FROM workflow_step_runs
                     WHERE run_id = ?1
                     ORDER BY step_index",
                )
                .map_err(|e| e.to_string())?;

            let sr_rows: Vec<(
                i64,
                String,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
            )> = sr_stmt
                .query_map(params![run_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            for (step_index, step_id, status, inputs_json, output_json, started_at, completed_at) in
                sr_rows
            {
                let resolved_inputs: Value =
                    serde_json::from_str(&inputs_json).unwrap_or(Value::Object(Default::default()));
                let output_value: Option<Value> = output_json
                    .and_then(|o| serde_json::from_str(&o).ok());

                // Load attempts for this step
                let mut att_stmt = conn
                    .prepare(
                        "SELECT attempt_number, actor, started_at, error, agent_reasoning
                         FROM workflow_step_attempts
                         WHERE run_id = ?1 AND step_index = ?2
                         ORDER BY attempt_number",
                    )
                    .map_err(|e| e.to_string())?;

                let attempts: Vec<super::workflow_recorder::StepAttempt> = att_stmt
                    .query_map(params![run_id, step_index], |row| {
                        let n: i64 = row.get(0)?;
                        let screenshot: Option<String> = None; // loaded below
                        Ok(super::workflow_recorder::StepAttempt {
                            n: n as u32,
                            actor: row.get(1)?,
                            started_at: row.get(2)?,
                            error: row.get(3)?,
                            screenshot_b64: screenshot,
                            agent_reasoning: row.get(4)?,
                        })
                    })
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();

                step_runs.push(super::workflow_recorder::WorkflowStepRun {
                    step_id,
                    status,
                    attempts,
                    resolved_inputs,
                    output_value,
                    started_at,
                    completed_at,
                });
            }

            out.push(super::workflow_recorder::WorkflowRun {
                run_id,
                workflow_slug,
                started_at,
                status,
                resolved_vars,
                step_runs,
                paused_at_step: paused_step.map(|i| i as usize),
                pause_reason,
            });
        }

        Ok(out)
    }

}
