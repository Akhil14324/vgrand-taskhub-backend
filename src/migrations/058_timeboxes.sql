-- Migration: 058_timeboxes.sql
-- Timebox planner: one box per person per day (brain dump, top three, half-hour blocks, an end-of-day note).
-- Planned in the morning, filled in and sent in the evening; once sent, people above the person can read it.
-- Additive only.

CREATE TABLE IF NOT EXISTS timeboxes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  box_date DATE NOT NULL,
  priorities JSONB NOT NULL DEFAULT '[]',   -- up to three: { text, todo_id?, done }
  brain_dump JSONB NOT NULL DEFAULT '[]',   -- { text, todo_id?, done }
  blocks JSONB NOT NULL DEFAULT '[]',       -- { start 'HH:MM', end 'HH:MM', text, todo_id?, priority?, done: true | false | null }
  reflection TEXT NOT NULL DEFAULT '',
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, box_date)
);
CREATE INDEX IF NOT EXISTS idx_timeboxes_date ON timeboxes(box_date);

-- Who has read a sent box (shown to its owner as "Seen by").
CREATE TABLE IF NOT EXISTS timebox_views (
  timebox_id INTEGER NOT NULL REFERENCES timeboxes(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (timebox_id, viewer_id)
);

-- One reminder of each kind per person per day, claimed with INSERT .. ON CONFLICT so two servers never both send.
CREATE TABLE IF NOT EXISTS timebox_nudges (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  kind TEXT NOT NULL,                       -- 'morning' | 'evening'
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day, kind)
);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_archive_deleted ON timeboxes;
  CREATE TRIGGER trg_archive_deleted BEFORE DELETE ON timeboxes FOR EACH ROW EXECUTE FUNCTION archive_deleted_row();
END $$;
