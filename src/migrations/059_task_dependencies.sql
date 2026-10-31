-- Migration: 059_task_dependencies.sql
-- "Dependent on": a task can wait for other tasks on the same board. Unlike a blocker (todo_blockers, which
-- marks the task Stuck), this is only about dates: when the task it depends on moves, the dependent task's
-- dates move by the same number of days (services/dependencies.js). Additive only.

CREATE TABLE IF NOT EXISTS todo_dependencies (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (todo_id, depends_on_id),
  CHECK (todo_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_todo_dependencies_on ON todo_dependencies(depends_on_id);

-- Boards say "Task", not "Item"; the three default columns get the names people expect.
ALTER TABLE boards ALTER COLUMN item_word SET DEFAULT 'Task';
UPDATE boards SET item_word = 'Task' WHERE item_word = 'Item';
UPDATE board_columns SET title = 'Owner' WHERE system_key = 'person' AND title = 'Person';
UPDATE board_columns SET title = 'Due date' WHERE system_key = 'date' AND title = 'Date';
UPDATE board_columns SET title = 'Dependent On' WHERE system_key = 'dependency' AND title = 'Dependencies';

-- Every live board gets the Dependent On, Notes and Files columns the default board has.
INSERT INTO board_columns (board_id, kind, title, system_key, width, sort_order, settings)
SELECT b.id, 'dependency', 'Dependent On', 'dependency', 170,
       COALESCE((SELECT MAX(sort_order) FROM board_columns c WHERE c.board_id = b.id), 0) + 1, '{}'
FROM boards b
WHERE b.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id AND c.system_key = 'status')
  AND NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id AND c.system_key = 'dependency' AND c.archived_at IS NULL);

INSERT INTO board_columns (board_id, kind, title, width, sort_order, settings)
SELECT b.id, 'long_text', 'Notes', 160,
       COALESCE((SELECT MAX(sort_order) FROM board_columns c WHERE c.board_id = b.id), 0) + 1, '{}'
FROM boards b
WHERE b.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id AND c.system_key = 'status')
  AND NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id AND c.title = 'Notes' AND c.archived_at IS NULL);

INSERT INTO board_columns (board_id, kind, title, width, sort_order, settings)
SELECT b.id, 'files', 'Files', 140,
       COALESCE((SELECT MAX(sort_order) FROM board_columns c WHERE c.board_id = b.id), 0) + 1, '{}'
FROM boards b
WHERE b.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id AND c.system_key = 'status')
  AND NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id AND c.kind = 'files' AND c.archived_at IS NULL);

-- Boards open with Main table, Gantt, Kanban and Calendar tabs. A board that has none of a kind gets it
-- (a tab someone closed stays archived, so it is only added when the kind was never there).
INSERT INTO board_views (board_id, owner_id, kind, name, settings, sort_order)
SELECT b.id, NULL, v.kind, v.name, v.settings::jsonb,
       COALESCE((SELECT MAX(sort_order) FROM board_views x WHERE x.board_id = b.id), 0) + v.ord
FROM boards b
CROSS JOIN (VALUES ('gantt', 'Gantt', '{}', 1), ('calendar', 'Calendar', '{}', 2)) AS v(kind, name, settings, ord)
WHERE b.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_views x WHERE x.board_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM board_views x WHERE x.board_id = b.id AND x.kind = v.kind);
