-- Migration: 024_add_replies_and_reactions.sql
-- Adds reply_to_id column to messages and creates message_reactions table

-- Add reply_to_id column for message replies
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

-- Create message_reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id
  ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user_id
  ON message_reactions(user_id);
