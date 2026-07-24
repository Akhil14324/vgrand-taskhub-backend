-- Migration: 011_add_hidden_to_participants.sql
-- Adds is_hidden column so users can "delete" a chat from their list
-- without removing the conversation for other participants

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
