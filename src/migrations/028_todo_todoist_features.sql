-- Migration: 028_todo_todoist_features.sql
-- Todoist-style to-do features: sub-tasks, labels, sections, comments, estimates,
-- deadlines, multiple reminders, saved filters, manual ordering and a daily goal.
-- Purely additive: every new column is nullable or has a default.

-- ---------------------------------------------------------------------------
-- Sections inside a list (also the columns of the board view)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo_sections (
  id SERIAL PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_sections_list ON todo_sections(list_id, sort_order);

-- ---------------------------------------------------------------------------
-- To-do fields
-- ---------------------------------------------------------------------------
-- Sub-tasks: a to-do whose parent_id is set. One level deep (enforced by the API).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES todos(id) ON DELETE CASCADE;
-- Free-form tags shared by everyone on the to-do (lower-case, no spaces).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';
-- Hard deadline, separate from the (movable) due date.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS deadline_date DATE;
-- Time estimate in minutes.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_duration_minutes_check;
ALTER TABLE todos ADD CONSTRAINT todos_duration_minutes_check
  CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 14400);
-- Extra reminders: minutes before the due time (the at-time reminder always fires).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS reminder_offsets INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE todos ADD COLUMN IF NOT EXISTS reminders_sent INTEGER[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id) WHERE parent_id IS NOT NULL;

-- Per-person placement (like list_id): section and manual order inside the list.
ALTER TABLE todo_members ADD COLUMN IF NOT EXISTS section_id INTEGER REFERENCES todo_sections(id) ON DELETE SET NULL;
ALTER TABLE todo_members ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo_comments (
  id SERIAL PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_comments_todo ON todo_comments(todo_id, created_at);

-- ---------------------------------------------------------------------------
-- Saved filters (config is evaluated by the client)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo_filters (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_filters_owner ON todo_filters(owner_id, sort_order);

-- ---------------------------------------------------------------------------
-- Productivity goal
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS todo_daily_goal SMALLINT NOT NULL DEFAULT 5;
