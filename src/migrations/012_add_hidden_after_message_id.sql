-- Migration: 012_add_hidden_after_message_id.sql
-- Tracks the last message ID visible before a user hid the conversation
-- so that when the chat reappears (via new message from other participant),
-- the user only sees messages from that point onward.

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS hidden_after_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
