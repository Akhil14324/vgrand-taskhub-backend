-- A deadline can have a time of day (the owner's request, 2026-11-18). Empty means the end of the day, as before.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS deadline_time TIME;
