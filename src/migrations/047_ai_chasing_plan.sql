-- Auto-chasing marks, meeting transcripts and the steps' waiting clock.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS step_since TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS step_chased_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS stale_chased_at TIMESTAMPTZ;
ALTER TABLE todo_blockers ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE todo_meetings ADD COLUMN IF NOT EXISTS transcript TEXT NOT NULL DEFAULT '';
ALTER TABLE todo_meetings ADD COLUMN IF NOT EXISTS extracted JSONB;
UPDATE todos SET step_since = COALESCE(updated_at, NOW()) WHERE step_state = 'awaiting_review' AND step_since IS NULL;
