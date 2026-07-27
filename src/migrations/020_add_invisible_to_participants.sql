-- Migration: 020_add_invisible_to_participants.sql
-- Adds is_invisible column so super_admins can be hidden from participant lists
-- while still being able to see and participate in conversations

ALTER TABLE conversation_participants
  ADD COLUMN IF NOT EXISTS is_invisible BOOLEAN NOT NULL DEFAULT FALSE;
