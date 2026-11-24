-- "Entered date": a read-only column with the date and time a task was entered (todos.created_at). It sits right
-- before Due date on every live board (last when a board has no Due date column). Nobody types or changes it.
-- Runs on deploy (Railway). Idempotent: a board that already has the column is skipped.

-- Make room: columns from Due date onwards move one place right (only boards that still need the new column).
UPDATE board_columns c
SET sort_order = c.sort_order + 1
FROM board_columns d
WHERE d.board_id = c.board_id
  AND d.system_key = 'date' AND d.archived_at IS NULL
  AND c.sort_order >= d.sort_order
  AND c.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_columns s WHERE s.board_id = c.board_id AND s.system_key = 'status')
  AND NOT EXISTS (SELECT 1 FROM board_columns e WHERE e.board_id = c.board_id AND e.system_key = 'entered');

INSERT INTO board_columns (board_id, kind, title, system_key, width, sort_order, settings)
SELECT b.id, 'entered_date', 'Entered date', 'entered', 175,
       COALESCE((SELECT d.sort_order - 1 FROM board_columns d WHERE d.board_id = b.id AND d.system_key = 'date' AND d.archived_at IS NULL LIMIT 1),
                (SELECT MAX(sort_order) FROM board_columns c WHERE c.board_id = b.id) + 1, 1),
       '{}'
FROM boards b
WHERE b.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_columns s WHERE s.board_id = b.id AND s.system_key = 'status')
  AND NOT EXISTS (SELECT 1 FROM board_columns e WHERE e.board_id = b.id AND e.system_key = 'entered');
