-- "Assigned by": a read-only column showing who gave the task to the person doing it (the last assignment, else whoever
-- made it). It sits right after Owner on every live board that has an Owner column. Nobody types or changes it.
-- Runs on deploy (Railway). Idempotent: a board that already has the column is skipped. Nothing existing is changed
-- except that the columns after Owner move one place right.

UPDATE board_columns c
SET sort_order = c.sort_order + 1
FROM board_columns p
WHERE p.board_id = c.board_id
  AND p.system_key = 'person' AND p.archived_at IS NULL
  AND c.sort_order > p.sort_order
  AND c.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM board_columns e WHERE e.board_id = c.board_id AND e.system_key = 'assigned_by');

INSERT INTO board_columns (board_id, kind, title, system_key, width, sort_order, settings)
SELECT b.id, 'assigned_by', 'Assigned by', 'assigned_by', 150,
       (SELECT p.sort_order + 1 FROM board_columns p WHERE p.board_id = b.id AND p.system_key = 'person' AND p.archived_at IS NULL LIMIT 1),
       '{}'
FROM boards b
WHERE b.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM board_columns p WHERE p.board_id = b.id AND p.system_key = 'person' AND p.archived_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM board_columns e WHERE e.board_id = b.id AND e.system_key = 'assigned_by');
