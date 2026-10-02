-- Sections can now belong to a person instead of a list, so the Inbox can be split into sections
-- (shown as columns on the board). Purely additive: existing list sections keep working.

ALTER TABLE todo_sections ALTER COLUMN list_id DROP NOT NULL;
ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

UPDATE todo_sections s SET owner_id = l.owner_id
FROM todo_lists l
WHERE l.id = s.list_id AND s.owner_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_todo_sections_owner ON todo_sections(owner_id, sort_order);
