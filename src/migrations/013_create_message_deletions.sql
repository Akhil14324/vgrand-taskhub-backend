-- Migration: 013_create_message_deletions.sql
-- Per-user message hide list for "delete for me" functionality

CREATE TABLE IF NOT EXISTS message_deletions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_deletions_user_id
  ON message_deletions(user_id);
CREATE INDEX IF NOT EXISTS idx_message_deletions_message_id
  ON message_deletions(message_id);
