-- Migration: 062_process_alerts.sql
-- One row per task that was reported as stalled (no step finished for a while while its date gets close), so the
-- same task is not reported every day. Additive only.
CREATE TABLE IF NOT EXISTS process_alerts (
  todo_id INTEGER PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE,
  alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
