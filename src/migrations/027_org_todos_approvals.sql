-- Migration: 027_org_todos_approvals.sql
-- Organisation hierarchy, personal/shared to-dos, task workflow (priority, review,
-- approvals, activity), richer notifications and FCM web-push tokens.

-- ---------------------------------------------------------------------------
-- Organisation hierarchy
-- ---------------------------------------------------------------------------
-- org_level: leadership tier above the businesses.
--   1 = Chairman (super admin), 2 = Chief of Staff, 3 = Director. NULL = not leadership.
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_level SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Designation of a person inside one business (head, manager, accountant, ...).
ALTER TABLE user_businesses ADD COLUMN IF NOT EXISTS designation VARCHAR(30) NOT NULL DEFAULT 'member';
ALTER TABLE user_businesses ADD COLUMN IF NOT EXISTS title VARCHAR(100);

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS color VARCHAR(20);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_org_level ON users(org_level);
CREATE INDEX IF NOT EXISTS idx_user_businesses_designation ON user_businesses(business_id, designation);

-- ---------------------------------------------------------------------------
-- Tasks: richer workflow
-- ---------------------------------------------------------------------------
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'in_progress', 'in_review', 'completed', 'on_hold'));

-- 1 = urgent (P1) ... 4 = no priority (P4), same scale as the to-do list.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 4;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
-- Business the request came from when a task is raised for another business.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

CREATE TABLE IF NOT EXISTS task_activity (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(30) NOT NULL,
  body TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_activity_task_id ON task_activity(task_id, created_at);

-- ---------------------------------------------------------------------------
-- Approvals (follow the chain of command)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(30) NOT NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  -- Snapshot of what the request is about, kept after the task is deleted.
  subject VARCHAR(500),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- An approver's effective level must be strictly lower (more senior) than this.
  requester_level SMALLINT NOT NULL DEFAULT 9,
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);

-- ---------------------------------------------------------------------------
-- To-dos (Todoist-style personal lists, shareable via @mentions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo_lists (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT 'indigo',
  emoji VARCHAR(16),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_lists_owner ON todo_lists(owner_id);

CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date DATE,
  due_time TIME,
  priority SMALLINT NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  recurrence VARCHAR(20) CHECK (recurrence IN ('daily', 'weekdays', 'weekly', 'monthly')),
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMPTZ,
  done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reminded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_date) WHERE is_done = FALSE;

DROP TRIGGER IF EXISTS update_todos_updated_at ON todos;
CREATE TRIGGER update_todos_updated_at BEFORE UPDATE ON todos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Everyone who has the to-do in their list (creator + @mentioned people).
CREATE TABLE IF NOT EXISTS todo_members (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id INTEGER REFERENCES todo_lists(id) ON DELETE SET NULL,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (todo_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_todo_members_user ON todo_members(user_id);

-- ---------------------------------------------------------------------------
-- Notifications: free-form types + deep-link data
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ALTER COLUMN type TYPE VARCHAR(30);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title VARCHAR(200);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Push tokens: Expo (native) and FCM (web / PWA)
-- ---------------------------------------------------------------------------
ALTER TABLE push_tokens ALTER COLUMN token TYPE TEXT;
ALTER TABLE push_tokens ALTER COLUMN platform TYPE VARCHAR(20);
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS provider VARCHAR(10) NOT NULL DEFAULT 'expo';

-- ---------------------------------------------------------------------------
-- Chat: structured message payloads (shared to-dos, shared tasks)
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;
