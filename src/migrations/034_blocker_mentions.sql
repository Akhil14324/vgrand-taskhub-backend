-- Migration: 034_blocker_mentions.sql
-- Blockers can tag people, to-dos and whole businesses: [{ "type": "user" | "todo" | "business", "id": 1, "label": "..." }].
-- The kind 'waiting_on' stays as the stored value; the app now calls it "Needs a decision".
ALTER TABLE todo_blockers ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]';
