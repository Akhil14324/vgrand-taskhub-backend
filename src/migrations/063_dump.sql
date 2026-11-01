-- Migration: 063_dump.sql
-- The Dump: a person can send all their open personal to-dos to a holding area to see everything fresh, then bring
-- each one back (or plan it) separately. It is a flag on the person's own membership of the to-do (todo_members),
-- so nothing moves or changes: the list, section and order stay as they were and come back on restore. Other people
-- on a shared to-do are not affected. Additive only.
ALTER TABLE todo_members ADD COLUMN IF NOT EXISTS dumped_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_todo_members_dumped ON todo_members(user_id) WHERE dumped_at IS NOT NULL;
