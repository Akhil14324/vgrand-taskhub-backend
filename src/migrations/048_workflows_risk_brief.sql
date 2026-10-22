-- Workflows (repeating processes that start themselves), early-warning marks and the daily brief log.
CREATE TABLE IF NOT EXISTS workflows (
  id            SERIAL PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id   INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  name          VARCHAR(200) NOT NULL,
  steps         JSONB NOT NULL DEFAULT '[]',
  recurrence    VARCHAR(10) NOT NULL DEFAULT 'monthly',
  next_run_date DATE NOT NULL,
  sequential    BOOLEAN NOT NULL DEFAULT FALSE,
  paused        BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflows_due ON workflows(next_run_date) WHERE paused = FALSE;

ALTER TABLE todos ADD COLUMN IF NOT EXISTS workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS workflow_next INTEGER;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS risk_warned_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS brief_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  kind    VARCHAR(20) NOT NULL,
  PRIMARY KEY (user_id, day, kind)
);
