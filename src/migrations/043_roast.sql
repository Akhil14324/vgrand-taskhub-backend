-- Migration: 043_roast.sql
-- Remembers when an overdue task last got its (opt-in, private) roast so it is repeated at most every 3 days.
-- Purely additive.

ALTER TABLE todos ADD COLUMN IF NOT EXISTS last_roast_at TIMESTAMPTZ;
