-- Migration: 052_workspace.sql
-- The business workspace: task types, epics, releases, time tracking and work-in-progress limits.
-- Sprints and story points arrived in 051. Additive only.

-- A business task is a task, a feature or a bug.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS item_type VARCHAR(8) NOT NULL DEFAULT 'task';
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_item_type_check;
ALTER TABLE todos ADD CONSTRAINT todos_item_type_check CHECK (item_type IN ('task', 'feature', 'bug'));

-- Epics: a big goal of one business that many tasks belong to.
CREATE TABLE IF NOT EXISTS epics (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_on DATE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_epics_business ON epics(business_id, status);

-- Releases: something the business ships, with the tasks that go into it.
CREATE TABLE IF NOT EXISTS releases (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  notes VARCHAR(500) NOT NULL DEFAULT '',
  stage VARCHAR(10) NOT NULL DEFAULT 'plan' CHECK (stage IN ('plan', 'build', 'test', 'released')),
  release_on DATE,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  released_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_releases_business ON releases(business_id, stage);

ALTER TABLE todos ADD COLUMN IF NOT EXISTS epic_id INTEGER REFERENCES epics(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_todos_epic ON todos(epic_id) WHERE epic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_release ON todos(release_id) WHERE release_id IS NOT NULL;

-- Time spent on a business task. A manager approves or rejects what the team logs.
CREATE TABLE IF NOT EXISTS time_logs (
  id SERIAL PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date DATE NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  note VARCHAR(300) NOT NULL DEFAULT '',
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_time_logs_todo ON time_logs(todo_id);
CREATE INDEX IF NOT EXISTS idx_time_logs_user_date ON time_logs(user_id, log_date);

-- One running timer per person.
CREATE TABLE IF NOT EXISTS time_timers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- How many tasks a status may hold at once, e.g. {"in_progress": 5}. Empty means no limit.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS wip_limits JSONB NOT NULL DEFAULT '{}'::jsonb;
