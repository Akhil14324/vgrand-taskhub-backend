-- Migration: 017_add_username.sql
-- Adds a unique username column to the users table.
-- Email becomes optional (kept for super_admin only).

ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(100);

-- Populate username from the local part of existing emails for backward compatibility
UPDATE users
SET username = split_part(email, '@', 1)
WHERE username IS NULL;

-- Make username unique and NOT NULL going forward
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_username_unique') THEN
    ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
  END IF;
END $$;

-- Email is no longer required for regular users (super_admin still uses it)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
