-- Step reviews: every top-level sub-task is a step; finishing one asks the person who set the work whether to
-- go on, redo it, stop, hand it over or raise a roadblock. Meetings: a Google Meet link made from a to-do.

ALTER TABLE todos ADD COLUMN IF NOT EXISTS step_state VARCHAR(20);

CREATE TABLE IF NOT EXISTS todo_step_reviews (
  id          SERIAL PRIMARY KEY,
  todo_id     INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision    VARCHAR(20) NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  target_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_step_reviews_todo ON todo_step_reviews(todo_id);

CREATE TABLE IF NOT EXISTS todo_meetings (
  id           SERIAL PRIMARY KEY,
  todo_id      INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  meet_url     TEXT NOT NULL,
  event_id     TEXT,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  attendee_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_meetings_todo ON todo_meetings(todo_id);
