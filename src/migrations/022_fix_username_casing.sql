-- Migration: 022_fix_username_casing.sql
-- Existing usernames were stored in all lowercase. Restore first-letter capitalization
-- so display matches what the user originally entered.

UPDATE users
SET username = INITCAP(username)
WHERE username = LOWER(username);
