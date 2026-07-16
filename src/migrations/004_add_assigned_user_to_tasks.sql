-- Migration: 004_add_assigned_user_to_tasks.sql
-- Adds optional assigned_user_id column to tasks for user-specific task assignment

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_user_id ON tasks(assigned_user_id);
