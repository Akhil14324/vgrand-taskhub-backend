-- Migration: 009_add_overdue_notification_support.sql
-- Adds 'overdue' notification type and a column to track the last overdue notification per task

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('warning', 'assignment', 'task_added', 'user_joined', 'task_completed', 'overdue'));

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_overdue_notification_at TIMESTAMPTZ;
