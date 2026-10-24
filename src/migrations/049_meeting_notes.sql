-- Meeting notes: a recording or pasted transcript that is not attached to a to-do. Owned by the person who
-- recorded it (only they see it). The transcript grows piece by piece while an hour-long meeting is recorded.

CREATE TABLE IF NOT EXISTS meeting_notes (
  id          SERIAL PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL DEFAULT 'Meeting',
  transcript  TEXT NOT NULL DEFAULT '',
  pieces      INTEGER NOT NULL DEFAULT 0,
  extracted   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_notes_owner ON meeting_notes(owner_id, created_at DESC);
