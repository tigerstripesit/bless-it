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

        if version < 2 {
            // Add gate_data column — safe to ignore if it already exists
            if let Err(e) = conn.execute_batch(
                "ALTER TABLE workflow_runs ADD COLUMN gate_data TEXT;",
            ) {
                log::warn!("Migration 002 (add gate_data) skipped: {}", e);
            }
            conn.execute_batch("PRAGMA user_version = 2")
                .map_err(|e| e.to_string())?;
        }

        if version < 3 {
            if let Err(e) = conn.execute_batch(include_str!("../migrations/003_traceability.sql")) {
                log::warn!("Migration 003 (traceability) skipped: {}", e);
            }
            conn.execute_batch("PRAGMA user_version = 3")
                .map_err(|e| e.to_string())?;
        }

        if version < 4 {
            if let Err(e) = conn.execute_batch(include_str!("../migrations/004_schedules.sql")) {
                log::warn!("Migration 004 (schedules) skipped: {}", e);
            }
            conn.execute_batch("PRAGMA user_version = 4")
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
        source_conversation_id: Option<&str>,
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
            "INSERT INTO workflow_runs (run_id, workflow_slug, started_at, status, resolved_vars, source_conversation_id)
             VALUES (?1, ?2, ?3, 'running', ?4, ?5)",
            params![run_id, workflow_slug, now, vars_json, source_conversation_id],
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
            gate_data: None,
            source_conversation_id: source_conversation_id.map(String::from),
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

    pub fn save_pending_gate(
        &self,
        run_id: &str,
        gate: &super::workflow_recorder::PendingGate,
    ) -> Result<(), String> {
        let gate_json =
            serde_json::to_string(gate).map_err(|e| format!("serialize gate: {}", e))?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE workflow_runs SET gate_data = ?1, status = 'paused',
                    paused_at_step = ?2, pause_reason = ?3
             WHERE run_id = ?4",
            params![
                gate_json,
                gate.step_index as i64,
                gate.gate_type,
                run_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_pending_gate(&self, run_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE workflow_runs SET gate_data = NULL, status = 'running' WHERE run_id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn insert_trace_event(&self, event: &super::workflow_recorder::InsertTraceEvent) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let data_json = serde_json::to_string(&event.event_data).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO workflow_trace_events (run_id, step_index, attempt_number, event_type, event_data)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event.run_id,
                event.step_index,
                event.attempt_number,
                event.event_type,
                data_json,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn query_trace_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<super::workflow_recorder::TraceEvent>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, run_id, step_index, attempt_number, event_type, event_data, created_at
                 FROM workflow_trace_events
                 WHERE run_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![run_id], |row| {
                let id: i64 = row.get(0)?;
                let run_id: String = row.get(1)?;
                let step_index: Option<i64> = row.get(2)?;
                let attempt_number: Option<i64> = row.get(3)?;
                let event_type: String = row.get(4)?;
                let data_str: String = row.get(5)?;
                let created_at: String = row.get(6)?;
                let event_data: serde_json::Value =
                    serde_json::from_str(&data_str).unwrap_or(serde_json::Value::Object(Default::default()));
                Ok(super::workflow_recorder::TraceEvent {
                    id,
                    run_id,
                    step_index,
                    attempt_number,
                    event_type,
                    event_data,
                    created_at,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
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

    // ── schedule management ────────────────────────────────────────────

    pub fn set_schedule(
        &self,
        workflow_slug: &str,
        cron_expression: &str,
        variables: &Value,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let vars_json = Self::vars_serialized(variables)?;
        conn.execute(
            "INSERT INTO workflow_schedules (workflow_slug, cron_expression, variables, next_run_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(workflow_slug) DO UPDATE SET
               cron_expression = excluded.cron_expression,
               variables       = excluded.variables,
               updated_at      = datetime('now')",
            params![workflow_slug, cron_expression, vars_json],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_schedule(
        &self,
        workflow_slug: &str,
    ) -> Result<Option<super::workflow_recorder::WorkflowSchedule>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_slug, cron_expression, variables, enabled,
                        last_run_at, next_run_at, created_at, updated_at
                 FROM workflow_schedules
                 WHERE workflow_slug = ?1",
            )
            .map_err(|e| e.to_string())?;

        let rows: Vec<super::workflow_recorder::WorkflowSchedule> = stmt
            .query_map(params![workflow_slug], |row| {
                let vars_str: String = row.get(3)?;
                let vars: Value = serde_json::from_str(&vars_str).unwrap_or(Value::Object(Default::default()));
                let enabled_int: i32 = row.get(4)?;
                Ok(super::workflow_recorder::WorkflowSchedule {
                    id: row.get(0)?,
                    workflow_slug: row.get(1)?,
                    cron_expression: row.get(2)?,
                    variables: vars,
                    enabled: enabled_int != 0,
                    last_run_at: row.get(5)?,
                    next_run_at: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows.into_iter().next())
    }

    pub fn list_schedules(
        &self,
    ) -> Result<Vec<super::workflow_recorder::WorkflowSchedule>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_slug, cron_expression, variables, enabled,
                        last_run_at, next_run_at, created_at, updated_at
                 FROM workflow_schedules
                 ORDER BY workflow_slug",
            )
            .map_err(|e| e.to_string())?;

        let rows: Vec<super::workflow_recorder::WorkflowSchedule> = stmt
            .query_map([], |row| {
                let vars_str: String = row.get(3)?;
                let vars: Value = serde_json::from_str(&vars_str).unwrap_or(Value::Object(Default::default()));
                let enabled_int: i32 = row.get(4)?;
                Ok(super::workflow_recorder::WorkflowSchedule {
                    id: row.get(0)?,
                    workflow_slug: row.get(1)?,
                    cron_expression: row.get(2)?,
                    variables: vars,
                    enabled: enabled_int != 0,
                    last_run_at: row.get(5)?,
                    next_run_at: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    pub fn delete_schedule(&self, workflow_slug: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM workflow_schedules WHERE workflow_slug = ?1",
            params![workflow_slug],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn toggle_schedule(&self, workflow_slug: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE workflow_schedules SET enabled = ?1, updated_at = datetime('now') WHERE workflow_slug = ?2",
            params![enabled as i32, workflow_slug],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Return all enabled schedules whose next_run_at is in the past (or NULL).
    /// The caller updates next_run_at after launching each run.
    pub fn due_schedules(&self) -> Result<Vec<super::workflow_recorder::WorkflowSchedule>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, workflow_slug, cron_expression, variables, enabled,
                        last_run_at, next_run_at, created_at, updated_at
                 FROM workflow_schedules
                 WHERE enabled = 1
                   AND (next_run_at IS NULL OR next_run_at <= datetime('now'))
                 ORDER BY next_run_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows: Vec<super::workflow_recorder::WorkflowSchedule> = stmt
            .query_map([], |row| {
                let vars_str: String = row.get(3)?;
                let vars: Value = serde_json::from_str(&vars_str).unwrap_or(Value::Object(Default::default()));
                let enabled_int: i32 = row.get(4)?;
                Ok(super::workflow_recorder::WorkflowSchedule {
                    id: row.get(0)?,
                    workflow_slug: row.get(1)?,
                    cron_expression: row.get(2)?,
                    variables: vars,
                    enabled: enabled_int != 0,
                    last_run_at: row.get(5)?,
                    next_run_at: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Mark a schedule as having been run (update last_run_at and next_run_at).
    pub fn mark_schedule_run(
        &self,
        schedule_id: i64,
        next_run_at: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE workflow_schedules
             SET last_run_at = datetime('now'),
                 next_run_at = ?1,
                 updated_at  = datetime('now')
             WHERE id = ?2",
            params![next_run_at, schedule_id],
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
                        paused_at_step, pause_reason, gate_data, source_conversation_id
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
            Option<String>,
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
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut out = Vec::with_capacity(run_rows.len());
        for (run_id, workflow_slug, started_at, status, vars_json, paused_step, pause_reason, gate_json, source_conversation_id) in
            run_rows
        {
            let gate_data: Option<super::workflow_recorder::PendingGate> = gate_json
                .and_then(|g| serde_json::from_str(&g).ok());
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
                            agent_model: None,
                            agent_usage: None,
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
                gate_data,
                source_conversation_id,
            });
        }

        Ok(out)
    }

}
