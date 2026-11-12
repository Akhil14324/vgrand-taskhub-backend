-- Migration: 066_section_parent_group.sql
-- A board group can sit under another group of the same board (e.g. flat groups under "Pending Remaining Works").
-- NULL = a top-level group, as before. Additive only: one nullable column and an index; no existing row changes.
ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS parent_group_id INTEGER REFERENCES todo_sections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_todo_sections_parent ON todo_sections(parent_group_id) WHERE parent_group_id IS NOT NULL;
