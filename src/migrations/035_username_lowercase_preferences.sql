-- Usernames are lowercase only. Lowercase every existing one that will not collide with another account
-- (a clash keeps its old spelling; logins and @mentions already ignore case).
UPDATE users u
SET username = LOWER(u.username)
WHERE u.username <> LOWER(u.username)
  AND (SELECT COUNT(*) FROM users o WHERE LOWER(o.username) = LOWER(u.username)) = 1;

-- Personal app settings (look and behaviour) that belong to one account and follow it across devices.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';
