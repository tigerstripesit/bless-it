-- Migration 004: Workflow schedule table for cron-based activity scheduling
--
-- The scheduler background task checks this table every 60 seconds and
-- launches workflow runs for any schedule whose next_run_at has passed.

CREATE TABLE IF NOT EXISTS workflow_schedules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_slug   TEXT NOT NULL UNIQUE,
    cron_expression TEXT NOT NULL,
    variables       TEXT NOT NULL DEFAULT '{}',
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_run_at     TEXT,
    next_run_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_next_run
    ON workflow_schedules(next_run_at)
    WHERE enabled = 1;
