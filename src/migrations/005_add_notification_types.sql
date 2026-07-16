-- Migration: 005_add_notification_types.sql
-- Adds 'user_joined' and 'task_completed' notification types

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('warning', 'assignment', 'task_added', 'user_joined', 'task_completed'));
