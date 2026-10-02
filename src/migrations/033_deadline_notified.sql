-- The day a "your deadline is today" notification was sent for a to-do. Compared with deadline_date,
-- so moving the deadline to another day makes it eligible again.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS deadline_notified_on DATE;
