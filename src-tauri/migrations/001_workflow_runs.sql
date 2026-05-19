-- Migration 001: Core workflow run state tables
--
-- Designed to replace the previous flat-file JSON approach with
-- normalized, indexed, transactional storage.
--
-- Design principles:
--   - workflow_runs: one row per run, lightweight metadata columns
--   - workflow_step_runs: upserted on every checkpoint (ON CONFLICT DO UPDATE)
--   - workflow_step_attempts: append-only, each retry gets one row
--   - workflow_screenshots: BLOBs stored once, referenced by FK

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id          TEXT PRIMARY KEY NOT NULL,
    workflow_slug   TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','paused','completed','failed','cancelled')),
    resolved_vars   TEXT NOT NULL DEFAULT '{}',
    paused_at_step  INTEGER,
    pause_reason    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    step_id         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    resolved_inputs TEXT NOT NULL DEFAULT '{}',
    output_value    TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    UNIQUE(run_id, step_index)
);

CREATE TABLE IF NOT EXISTS workflow_step_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    attempt_number  INTEGER NOT NULL,
    actor           TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    error           TEXT,
    agent_reasoning TEXT,
    UNIQUE(run_id, step_index, attempt_number)
);

CREATE TABLE IF NOT EXISTS workflow_screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
    step_index      INTEGER NOT NULL,
    attempt_number  INTEGER NOT NULL,
    screenshot_b64  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_step_runs_run_id ON workflow_step_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_step_attempts_run_id ON workflow_step_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_run_id ON workflow_screenshots(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_slug ON workflow_runs(workflow_slug);
CREATE INDEX IF NOT EXISTS idx_runs_created ON workflow_runs(created_at);
