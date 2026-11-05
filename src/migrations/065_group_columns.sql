-- Migration: 065_group_columns.sql
-- A column can belong to one group of a board: it is shown only in that group's table. NULL = every group
-- (the board-wide columns, as before). On a "My to-dos" board the group is a todo_lists id, so there is no
-- foreign key; deleting a group archives its own columns. Additive only.
ALTER TABLE board_columns ADD COLUMN IF NOT EXISTS group_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_board_columns_group ON board_columns(board_id, group_id) WHERE group_id IS NOT NULL;
