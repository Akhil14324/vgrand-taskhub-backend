-- A task that was declined (sent back) or handed on: who did it, who had given it to them, when and why, so the person
-- who gave it can see it. Cleared when they dismiss the notice or give the task to someone again. Additive: five empty
-- columns on todos, nothing existing changes.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS declined_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS declined_giver INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS declined_reason TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS declined_kind VARCHAR(12);
CREATE INDEX IF NOT EXISTS idx_todos_declined_giver ON todos(declined_giver) WHERE declined_at IS NOT NULL;
