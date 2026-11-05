-- Migration: 064_watching.sql
-- Someone who hands a personal to-do to another person keeps following it: a "watching" membership. It is hidden
-- from every normal list (Inbox, Today, lists, boards, counts) like a dumped one, and shown only in the Assigned view
-- (GET /api/todos returns it under `watching`), with its sub-tasks. The watcher may add sub-tasks and comment; the
-- person it was given to stays accountable. Additive only.
ALTER TABLE todo_members ADD COLUMN IF NOT EXISTS watching BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_todo_members_watching ON todo_members(user_id) WHERE watching;
