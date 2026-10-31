-- Nothing is lost for good: every row deleted from the tables below (directly, or by an ON DELETE CASCADE)
-- is copied into deleted_rows first, as JSON, with the time and the transaction. A deleted to-do, person,
-- business or section can be put back from there (see src/scripts/restore-deleted.js).
--
-- Not archived on purpose: chat messages (the 30-day chat retention is a deliberate rule), notifications,
-- logs and per-viewer ordering, which are either policy-bound or rebuilt by the app.

CREATE TABLE IF NOT EXISTS deleted_rows (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT,
  data JSONB NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  txid BIGINT NOT NULL DEFAULT txid_current(),
  restored_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deleted_rows_table ON deleted_rows(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_deleted_rows_time ON deleted_rows(deleted_at DESC);

CREATE OR REPLACE FUNCTION archive_deleted_row() RETURNS trigger AS $$
BEGIN
  INSERT INTO deleted_rows (table_name, row_id, data)
  VALUES (TG_TABLE_NAME, (to_jsonb(OLD) ->> 'id'), to_jsonb(OLD));
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- The archive itself is append-only: rows can be marked restored, never removed or rewritten.
CREATE OR REPLACE FUNCTION deleted_rows_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deleted_rows is append-only';
  END IF;
  IF NEW.data IS DISTINCT FROM OLD.data OR NEW.table_name IS DISTINCT FROM OLD.table_name THEN
    RAISE EXCEPTION 'deleted_rows is append-only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deleted_rows_guard ON deleted_rows;
CREATE TRIGGER trg_deleted_rows_guard BEFORE UPDATE OR DELETE ON deleted_rows
  FOR EACH ROW EXECUTE FUNCTION deleted_rows_guard();

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'todos', 'todo_members', 'todo_comments', 'todo_attachments', 'todo_blockers', 'todo_sections',
    'todo_lists', 'todo_filters', 'todo_step_reviews', 'todo_meetings', 'todo_templates',
    'users', 'businesses', 'user_businesses', 'sites', 'site_members',
    'approvals', 'warnings', 'time_logs', 'goals', 'goal_key_results', 'sprints', 'epics', 'releases',
    'tasks', 'task_activity', 'meeting_notes', 'workflows', 'automation_profiles', 'automation_tasks', 'standups'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON %I', t);
      EXECUTE format(
        'CREATE TRIGGER trg_archive_deleted BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION archive_deleted_row()',
        t
      );
    END IF;
  END LOOP;
END $$;
