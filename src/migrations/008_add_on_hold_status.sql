-- Migration: 008_add_on_hold_status.sql
-- Adds 'on_hold' as a valid task status

-- Drop the old constraint and add a new one that includes 'on_hold'
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'completed', 'on_hold'));
