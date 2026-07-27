-- Migration: 019_fix_user_joined_notifications.sql
-- Updates old 'user_joined' notifications that still contain an email address
-- in parentheses to use the corresponding username.

UPDATE notifications n
SET message = regexp_replace(
  n.message,
  '\(([^)]+@[^)]+\.[^)]+)\)',
  '(' || u.username || ')'
)
FROM users u
WHERE n.type = 'user_joined'
  AND n.message ~ '\(([^)]+@[^)]+\.[^)]+)\)'
  AND u.email = (regexp_match(n.message, '\(([^)]+@[^)]+\.[^)]+)\)'))[1];
