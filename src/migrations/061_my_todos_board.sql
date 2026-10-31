-- Migration: 061_my_todos_board.sql
-- "My to-dos": every person gets one personal board (kind 'my_todos') that lists the personal to-dos they are on,
-- grouped by their own lists. It is a view over the existing to-dos: nothing is copied or moved, and todos.board_id
-- is untouched. The board row itself is created the first time the person's boards are listed. Additive only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_boards_my_todos ON boards(owner_id) WHERE kind = 'my_todos';
