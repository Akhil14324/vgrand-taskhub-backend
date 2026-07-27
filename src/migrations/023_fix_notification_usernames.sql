-- Migration: 023_fix_notification_usernames.sql
-- Existing notifications stored the username in parentheses before the casing fix.
-- Update those messages to use the corrected (current) username casing.

DO $$
DECLARE
  u RECORD;
BEGIN
  FOR u IN SELECT username FROM users LOOP
    UPDATE notifications
    SET message = REPLACE(message, ' (' || LOWER(u.username) || ')', ' (' || u.username || ')')
    WHERE message LIKE '% (' || LOWER(u.username) || ')%';
  END LOOP;
END $$;
