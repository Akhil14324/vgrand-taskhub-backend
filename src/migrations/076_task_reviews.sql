-- Review & Approval: each time a task is sent to a chosen reviewer is one row. The decision fills in that row and a
-- later round adds a new one, so the rows of a task are its complete review history. New table only; the task
-- itself stays in `todos`. Names are copied so history still reads correctly if a person is removed.
CREATE TABLE IF NOT EXISTS task_reviews (
  id SERIAL PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  round INTEGER NOT NULL DEFAULT 1,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitter_name TEXT NOT NULL,
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_name TEXT NOT NULL,
  submit_note TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected', 'withdrawn')),
  decision_note TEXT,
  decided_at TIMESTAMPTZ
);
-- A task is with at most one reviewer at a time.
CREATE UNIQUE INDEX IF NOT EXISTS task_reviews_one_pending ON task_reviews (todo_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS task_reviews_todo_idx ON task_reviews (todo_id, id);
CREATE INDEX IF NOT EXISTS task_reviews_reviewer_idx ON task_reviews (reviewer_id, status);
CREATE INDEX IF NOT EXISTS task_reviews_submitter_idx ON task_reviews (submitted_by, id DESC);

-- Rows deleted along with a task are archived like the task's other rows (migration 054), so restoring the task
-- from the recycle bin brings its review history back.
DROP TRIGGER IF EXISTS trg_archive_deleted ON task_reviews;
CREATE TRIGGER trg_archive_deleted BEFORE DELETE ON task_reviews
  FOR EACH ROW EXECUTE FUNCTION archive_deleted_row();
