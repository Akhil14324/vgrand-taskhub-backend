-- Migration: 031_todo_board_order.sql
-- Each person arranges the cards of a board the way they like. The order is theirs alone, so it
-- works for business to-dos too (which everyone in the business can see).
CREATE TABLE IF NOT EXISTS todo_board_order (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, todo_id)
);
CREATE INDEX IF NOT EXISTS idx_todo_board_order_user ON todo_board_order(user_id);
