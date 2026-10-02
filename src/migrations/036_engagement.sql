-- Migration: 036_engagement.sql
-- Engagement: streak rest days, "day complete" record, kudos, morning digest log and blocker nudges.
-- Additive only.

-- A day the person chose to rest: it never breaks their streak (weekends never do either).
CREATE TABLE IF NOT EXISTS streak_rests (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);

-- A day on which the person finished everything that was due (and finished at least one thing).
CREATE TABLE IF NOT EXISTS daily_clear (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);

-- Thanks between colleagues, optionally about one to-do.
CREATE TABLE IF NOT EXISTS kudos (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  reason VARCHAR(20) NOT NULL DEFAULT 'great_work',
  message VARCHAR(280) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_kudos_to ON kudos(to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kudos_from ON kudos(from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kudos_created ON kudos(created_at DESC);

-- One morning digest per person per day (the INSERT is the claim, so only one server sends it).
CREATE TABLE IF NOT EXISTS digest_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- The last day somebody was reminded that this blocker is waiting on them.
ALTER TABLE todo_blockers ADD COLUMN IF NOT EXISTS nudged_on DATE;

-- Monday recap notification claim, one per person per week (keyed by the Monday).
CREATE TABLE IF NOT EXISTS recap_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  PRIMARY KEY (user_id, week_start)
);
