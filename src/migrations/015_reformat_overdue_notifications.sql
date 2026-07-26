-- Migration: 015_reformat_overdue_notifications.sql
-- Reformat stored overdue notification messages so the due date is clean
-- (e.g. "Jul 23, 2026" instead of the raw Date.toString() output).

UPDATE notifications
SET message = regexp_replace(
  message,
  'Due date was [A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT[+-]\d{4}( \([^)]+\))?\.',
  'Due date was \1 \2, \3.',
  'g'
)
WHERE type = 'overdue'
  AND message ~ 'Due date was [A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}';
