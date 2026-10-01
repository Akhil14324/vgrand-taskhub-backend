-- Migration: 029_todo_timeline.sql
-- To-do workflow + timeline: status, accountable assignee, blockers, an append-only event log,
-- and the data the Team Monitor needs (who did what, how long it took).
-- Additive only; existing to-dos are back-filled.

-- ---------------------------------------------------------------------------
-- Status & ownership
-- ---------------------------------------------------------------------------
-- todo → in_progress → blocked (while a blocker is open) → done. `is_done` stays the source of
-- truth for "finished"; status = 'done' mirrors it.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'todo';
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
ALTER TABLE todos ADD CONSTRAINT todos_status_check CHECK (status IN ('todo', 'in_progress', 'blocked', 'done'));

-- The one person accountable for the to-do (others on it are collaborators).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- When the current assignee got it (starts the "response time" clock).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
-- First time work began on the current round.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
-- Time-in-status bookkeeping: seconds spent in each closed status span, and when the current one began.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS status_since TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE todos ADD COLUMN IF NOT EXISTS status_seconds JSONB NOT NULL DEFAULT '{}';

UPDATE todos SET status = 'done' WHERE is_done = TRUE AND status <> 'done';
UPDATE todos SET assignee_id = created_by, assigned_at = created_at, status_since = COALESCE(done_at, created_at)
  WHERE assignee_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_todos_assignee ON todos(assignee_id) WHERE is_done = FALSE;

-- ---------------------------------------------------------------------------
-- Blockers: anything that stops or slows the work
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo_blockers (
  id SERIAL PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  -- dependency: needs another to-do first · waiting_on: needs a person · issue: a problem · dead_stop: cannot continue at all
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('dependency', 'waiting_on', 'issue', 'dead_stop')),
  note TEXT NOT NULL DEFAULT '',
  blocked_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  blocked_by_todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_todo_blockers_todo ON todo_blockers(todo_id, raised_at);
CREATE INDEX IF NOT EXISTS idx_todo_blockers_open ON todo_blockers(todo_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_todo_blockers_dep ON todo_blockers(blocked_by_todo_id) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Event log. Kept when a to-do is deleted (todo_id becomes NULL, the title stays in meta) so
-- nobody can erase their history by deleting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo_events (
  id SERIAL PRIMARY KEY,
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  -- Who did it.
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Whose work it concerns (the assignee at that moment); drives the per-person feeds and metrics.
  subject_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- created · assigned · shared · status · blocker_raised · blocker_cleared · update · due_changed
  -- deadline_changed · priority_changed · completed · reopened · question · deleted
  kind VARCHAR(30) NOT NULL,
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_events_todo ON todo_events(todo_id, created_at);
CREATE INDEX IF NOT EXISTS idx_todo_events_subject ON todo_events(subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_todo_events_kind ON todo_events(kind, created_at DESC);

-- Comments can be questions from someone monitoring ("why is this taking so long?").
ALTER TABLE todo_comments ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'comment';

-- ---------------------------------------------------------------------------
-- Back-fill: a "created" event for every existing to-do, plus a "completed" event with the
-- little that is known, so timelines and metrics are not empty on day one.
-- ---------------------------------------------------------------------------
INSERT INTO todo_events (todo_id, user_id, subject_id, kind, created_at, meta)
SELECT t.id, t.created_by, t.created_by, 'created', t.created_at,
       jsonb_build_object('title', t.title, 'backfilled', TRUE)
FROM todos t
WHERE NOT EXISTS (SELECT 1 FROM todo_events e WHERE e.todo_id = t.id AND e.kind = 'created');

INSERT INTO todo_events (todo_id, user_id, subject_id, kind, created_at, meta)
SELECT t.id, t.done_by, COALESCE(t.assignee_id, t.created_by), 'completed', t.done_at,
       jsonb_build_object(
         'title', t.title, 'backfilled', TRUE, 'assignee_id', COALESCE(t.assignee_id, t.created_by),
         'is_subtask', t.parent_id IS NOT NULL,
         'lead_s', GREATEST(0, EXTRACT(EPOCH FROM (t.done_at - t.created_at))::bigint),
         'cycle_s', GREATEST(0, EXTRACT(EPOCH FROM (t.done_at - t.created_at))::bigint),
         'blocked_s', 0,
         'estimate_min', t.duration_minutes)
FROM todos t
WHERE t.is_done = TRUE AND t.done_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM todo_events e WHERE e.todo_id = t.id AND e.kind = 'completed');
