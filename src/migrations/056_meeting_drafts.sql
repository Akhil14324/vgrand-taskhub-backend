-- Meetings become drafts you review (MONDAY_FEATURE_SPEC.md F-MTG-02, F-MTG-05). Additive only.
--   meeting_notes.business_id   the company a meeting was about (default home for its tasks)
--   meeting_pieces              recorded pieces in order; a retried upload of the same piece is ignored
--   todo_drafts                 tasks found in a meeting (or a pasted message) waiting for the recorder's OK

ALTER TABLE meeting_notes ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS meeting_pieces (
  meeting_id INTEGER NOT NULL REFERENCES meeting_notes(id) ON DELETE CASCADE,
  piece_no INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (meeting_id, piece_no)
);

CREATE TABLE IF NOT EXISTS todo_drafts (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_id INTEGER REFERENCES meeting_notes(id) ON DELETE SET NULL,
  source VARCHAR(12) NOT NULL DEFAULT 'meeting' CHECK (source IN ('meeting', 'message', 'photo')),
  title VARCHAR(500) NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_said VARCHAR(120),
  confidence VARCHAR(8) NOT NULL DEFAULT 'sure' CHECK (confidence IN ('sure', 'unsure', 'mine')),
  business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  due_date DATE,
  due_time TIME,
  priority SMALLINT CHECK (priority BETWEEN 1 AND 4),
  position INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(8) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'created', 'dropped')),
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_todo_drafts_owner ON todo_drafts(owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_todo_drafts_meeting ON todo_drafts(meeting_id);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['meeting_pieces', 'todo_drafts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_archive_deleted BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION archive_deleted_row()', t);
  END LOOP;
END $$;
