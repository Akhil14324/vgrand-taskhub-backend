-- Migration: 030_unify_tasks_into_todos.sql
-- One item type. A "task" is now a to-do that belongs to a business (todos.business_id is set).
-- Business items keep everything tasks had: org-hierarchy permissions, review before completion,
-- warnings, delete requests and history. Items proposed by someone who is not allowed to set
-- business work directly wait for review (review_state).
--
-- Additive: the old `tasks` / `task_activity` tables are left untouched (they are dropped in a
-- later migration once nothing reads them). Existing tasks are COPIED into `todos`; the id of the
-- original is kept in todos.legacy_task_id, so this file can never create a task twice.

-- ---------------------------------------------------------------------------
-- Business scope & governance
-- ---------------------------------------------------------------------------
ALTER TABLE todos ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE;
-- Business the request came from when work is raised for another business.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL;

-- Completion has to be reviewed by someone senior (status goes through 'in_review').
ALTER TABLE todos ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Business items set by someone who may not do so directly are 'proposed' until a senior person
-- accepts or rejects them. Everything else is 'accepted'.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS review_state VARCHAR(10) NOT NULL DEFAULT 'accepted';
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_review_state_check;
ALTER TABLE todos ADD CONSTRAINT todos_review_state_check CHECK (review_state IN ('accepted', 'proposed', 'rejected'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS review_note TEXT;

ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_warned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS last_overdue_notification_at TIMESTAMPTZ;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS legacy_task_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_legacy_task ON todos(legacy_task_id) WHERE legacy_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_business ON todos(business_id) WHERE business_id IS NOT NULL;

-- Statuses: the to-do workflow plus the two task-only ones.
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
ALTER TABLE todos ADD CONSTRAINT todos_status_check
  CHECK (status IN ('todo', 'in_progress', 'blocked', 'in_review', 'on_hold', 'done'));

-- Warnings and approvals point at to-dos now (task_id stays for rows written before this migration).
ALTER TABLE warnings ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE warnings ADD COLUMN IF NOT EXISTS todo_id INTEGER REFERENCES todos(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_warnings_todo_id ON warnings(todo_id);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_todo_id ON approvals(todo_id);

-- ---------------------------------------------------------------------------
-- Copy the existing tasks
-- ---------------------------------------------------------------------------
INSERT INTO todos (
  created_by, title, notes, due_date, priority, is_done, done_at, done_by,
  status, assignee_id, assigned_at, started_at, status_since,
  business_id, source_business_id, requires_approval, approved_by, approved_at,
  submitted_by, submitted_at, is_warned, last_overdue_notification_at,
  created_at, updated_at, legacy_task_id
)
SELECT
  t.created_by, t.title, COALESCE(t.description, ''), t.due_date, t.priority,
  (t.status = 'completed'),
  CASE WHEN t.status = 'completed' THEN COALESCE(t.completed_at, t.updated_at) END,
  CASE WHEN t.status = 'completed' THEN t.completed_by END,
  CASE t.status WHEN 'pending' THEN 'todo' WHEN 'completed' THEN 'done' ELSE t.status END,
  t.assigned_user_id,
  CASE WHEN t.assigned_user_id IS NOT NULL THEN t.created_at END,
  CASE WHEN t.status IN ('in_progress', 'in_review') THEN t.updated_at END,
  COALESCE(CASE WHEN t.status = 'completed' THEN t.completed_at END, t.updated_at, t.created_at),
  t.business_id, t.source_business_id, t.requires_approval, t.approved_by, t.approved_at,
  CASE WHEN t.status = 'in_review' THEN t.completed_by END,
  CASE WHEN t.status = 'in_review' THEN t.completed_at END,
  t.is_warned, t.last_overdue_notification_at,
  t.created_at, t.updated_at, t.id
FROM tasks t
WHERE NOT EXISTS (SELECT 1 FROM todos x WHERE x.legacy_task_id = t.id);

-- Whoever created or was given a business item is on it (for notifications and timelines).
INSERT INTO todo_members (todo_id, user_id, list_id, added_by)
SELECT x.id, m.uid, NULL, x.created_by
FROM todos x
CROSS JOIN LATERAL (VALUES (x.created_by), (x.assignee_id)) AS m(uid)
WHERE x.legacy_task_id IS NOT NULL AND m.uid IS NOT NULL
ON CONFLICT DO NOTHING;

-- Task comments become to-do comments; every other activity row becomes a timeline event.
INSERT INTO todo_comments (todo_id, user_id, body, kind, created_at)
SELECT x.id, ta.user_id, ta.body, 'comment', ta.created_at
FROM task_activity ta
JOIN todos x ON x.legacy_task_id = ta.task_id
WHERE ta.kind = 'comment' AND ta.body IS NOT NULL AND ta.body <> '';

INSERT INTO todo_events (todo_id, user_id, subject_id, kind, from_value, to_value, note, meta, created_at)
SELECT x.id, ta.user_id, x.assignee_id, ta.kind,
  CASE WHEN ta.kind = 'status' THEN
    CASE ta.meta->>'from' WHEN 'pending' THEN 'todo' WHEN 'completed' THEN 'done' ELSE ta.meta->>'from' END END,
  CASE WHEN ta.kind = 'status' THEN
    CASE ta.meta->>'to' WHEN 'pending' THEN 'todo' WHEN 'completed' THEN 'done' ELSE ta.meta->>'to' END END,
  ta.body,
  COALESCE(ta.meta, '{}'::jsonb) || jsonb_build_object('title', x.title, 'from_task', TRUE),
  ta.created_at
FROM task_activity ta
JOIN todos x ON x.legacy_task_id = ta.task_id
WHERE ta.kind <> 'comment';

-- Timelines and the Team Monitor need a "created" and, for finished work, a "completed" event.
INSERT INTO todo_events (todo_id, user_id, subject_id, kind, created_at, meta)
SELECT x.id, x.created_by, COALESCE(x.assignee_id, x.created_by), 'created', x.created_at,
       jsonb_build_object('title', x.title, 'backfilled', TRUE, 'from_task', TRUE)
FROM todos x
WHERE x.legacy_task_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM todo_events e WHERE e.todo_id = x.id AND e.kind = 'created');

INSERT INTO todo_events (todo_id, user_id, subject_id, kind, created_at, meta)
SELECT x.id, x.done_by, COALESCE(x.assignee_id, x.created_by), 'completed', x.done_at,
       jsonb_build_object(
         'title', x.title, 'backfilled', TRUE, 'from_task', TRUE,
         'assignee_id', COALESCE(x.assignee_id, x.created_by), 'is_subtask', FALSE,
         'lead_s', GREATEST(0, EXTRACT(EPOCH FROM (x.done_at - x.created_at))::bigint),
         'cycle_s', GREATEST(0, EXTRACT(EPOCH FROM (x.done_at - x.created_at))::bigint),
         'blocked_s', 0)
FROM todos x
WHERE x.legacy_task_id IS NOT NULL AND x.is_done AND x.done_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM todo_events e WHERE e.todo_id = x.id AND e.kind = 'completed');

-- Point the things that referenced a task at its to-do.
UPDATE warnings w SET todo_id = x.id
FROM todos x WHERE x.legacy_task_id = w.task_id AND w.todo_id IS NULL;

UPDATE approvals a SET todo_id = x.id
FROM todos x WHERE x.legacy_task_id = a.task_id AND a.todo_id IS NULL;

UPDATE notifications n
SET data = (n.data - 'taskId') || jsonb_build_object('todoId', x.id)
FROM todos x
WHERE n.data IS NOT NULL AND n.data ? 'taskId' AND x.legacy_task_id = (n.data->>'taskId')::int;

-- Task cards already shared in chats now open the matching to-do.
DO $$
DECLARE
  r RECORD;
  item JSONB;
  items JSONB;
  new_id INTEGER;
  first_item JSONB;
BEGIN
  FOR r IN SELECT id, meta FROM messages WHERE meta IS NOT NULL AND meta->>'kind' = 'task' LOOP
    items := '[]'::jsonb;
    FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(r.meta->'tasks', '[]'::jsonb)) LOOP
      SELECT id INTO new_id FROM todos WHERE legacy_task_id = (item->>'id')::int;
      items := items || jsonb_build_array(
        CASE WHEN new_id IS NULL THEN item ELSE jsonb_set(item, '{id}', to_jsonb(new_id)) END
      );
    END LOOP;
    first_item := CASE WHEN jsonb_array_length(items) > 0 THEN items->0 ELSE r.meta->'task' END;
    UPDATE messages SET meta = jsonb_set(jsonb_set(r.meta, '{tasks}', items), '{task}', COALESCE(first_item, 'null'::jsonb))
    WHERE id = r.id;
  END LOOP;
END $$;
