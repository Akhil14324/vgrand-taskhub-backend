-- Migration: 038_goals.sql
-- Goals and key results (OKRs). A goal belongs to the company, one business, or one person; its key
-- results are either a number that somebody updates, or a set of linked to-dos that measure themselves.
-- Additive only.

CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope VARCHAR(10) NOT NULL DEFAULT 'personal' CHECK (scope IN ('company', 'business', 'personal')),
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'dropped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_goals_scope ON goals(scope, business_id);
CREATE INDEX IF NOT EXISTS idx_goals_owner ON goals(owner_id);

CREATE TABLE IF NOT EXISTS goal_key_results (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'number' CHECK (kind IN ('number', 'todos')),
  unit VARCHAR(20) NOT NULL DEFAULT '',
  start_value NUMERIC NOT NULL DEFAULT 0,
  target_value NUMERIC NOT NULL DEFAULT 100,
  current_value NUMERIC NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goal_krs_goal ON goal_key_results(goal_id, sort_order);

CREATE TABLE IF NOT EXISTS goal_key_result_todos (
  key_result_id INTEGER NOT NULL REFERENCES goal_key_results(id) ON DELETE CASCADE,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  PRIMARY KEY (key_result_id, todo_id)
);
CREATE INDEX IF NOT EXISTS idx_goal_kr_todos_todo ON goal_key_result_todos(todo_id);
