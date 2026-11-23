-- Migration: 074_notification_event_key.sql
-- A reminder is created once per event: the key names the event ("remind:<todo>:<due>:<lead>"), and the unique
-- index lets the database refuse a second copy for the same person, even if two server instances race.
-- Only a nullable column and an index are added; existing rows and notifications without a key are untouched.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_key VARCHAR(160);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_user_event ON notifications (user_id, event_key) WHERE event_key IS NOT NULL;
