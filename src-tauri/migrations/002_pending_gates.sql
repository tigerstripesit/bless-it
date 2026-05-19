-- Migration 002: Add gate_data column for sticky human gates
--
-- Stores the serialized gate state (type, prompt, inputs, step info)
-- so that paused runs survive app restart and the UI can re-render
-- the correct gate without re-executing the step.

ALTER TABLE workflow_runs ADD COLUMN gate_data TEXT;
