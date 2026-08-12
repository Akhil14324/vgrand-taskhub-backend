-- Migration: 025_add_edit_pin_profile_lastseen.sql
-- Adds message editing, pinned messages, profile pictures, last seen tracking

-- Add edited_at already exists, add is_edited flag for quick filtering
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN NOT NULL DEFAULT FALSE;

-- Add is_pinned column to conversations for pinned messages
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS pinned_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;

-- Add profile picture and last_seen to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture VARCHAR(1024);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- Add mute toggle to conversation_participants
ALTER TABLE conversation_participants ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT FALSE;
