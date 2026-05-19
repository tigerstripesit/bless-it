-- Migration 003: Traceability — link runs to conversations and emit structured trace events
--
-- Adds:
--   - source_conversation_id to workflow_runs (link back to the conversation that spawned the run)
--   - workflow_trace_events table (chronological event log per run)
--
-- event_type values:
--   run_start, run_complete, run_fail, run_cancel,
--   step_start, step_ok, step_fail,
--   recovery_start, recovery_ok, recovery_fail,
--   gate_pause, gate_resolve,
--   human_input, human_intervention, approval,
--   tool_call, tool_result

ALTER TABLE workflow_runs ADD COLUMN source_conversation_id TEXT;

CREATE TABLE IF NOT EXISTS workflow_trace_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    step_index      INTEGER,
    attempt_number  INTEGER,
    event_type      TEXT NOT NULL,
    event_data      TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trace_events_run ON workflow_trace_events(run_id);
CREATE INDEX IF NOT EXISTS idx_trace_events_type ON workflow_trace_events(event_type);
