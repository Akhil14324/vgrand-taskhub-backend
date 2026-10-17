-- Migration: 045_automation.sql
-- Automations (profiles, tasks, variables). A profile is "when this happens (contexts), run that (task)";
-- a task is an ordered list of actions kept as JSON. Everything belongs to one person and runs with that
-- person's own permissions. Additive only.

CREATE TABLE IF NOT EXISTS automation_tasks (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(300) NOT NULL DEFAULT '',
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_tasks_owner ON automation_tasks(owner_id);

CREATE TABLE IF NOT EXISTS automation_profiles (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(300) NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  contexts JSONB NOT NULL DEFAULT '[]'::jsonb,
  match_mode VARCHAR(3) NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  enter_task_id INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
  exit_task_id INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 5 CHECK (cooldown_seconds >= 0),
  priority INTEGER NOT NULL DEFAULT 5,
  -- State profiles: whether all its state contexts held at the last check.
  active BOOLEAN NOT NULL DEFAULT FALSE,
  -- Time contexts: the minute (YYYY-MM-DDTHH:MM in APP_TIMEZONE) it last fired, so a minute never fires twice.
  last_slot VARCHAR(20),
  last_fired_at TIMESTAMPTZ,
  run_count INTEGER NOT NULL DEFAULT 0,
  hook_token VARCHAR(48) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_profiles_owner ON automation_profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_automation_profiles_enabled ON automation_profiles(enabled) WHERE enabled;

-- Global variables (the UPPERCASE ones). Local variables live only for one run.
CREATE TABLE IF NOT EXISTS automation_vars (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(40) NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, name)
);

-- The log of runs: kept short per person (the newest 60).
CREATE TABLE IF NOT EXISTS automation_runs (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id INTEGER REFERENCES automation_profiles(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
  profile_name VARCHAR(80),
  task_name VARCHAR(80),
  trigger VARCHAR(60) NOT NULL DEFAULT 'manual',
  status VARCHAR(10) NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'stopped', 'limit')),
  error TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  log JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_owner ON automation_runs(owner_id, started_at DESC);

-- What the person's open app last told us about the device (battery, connection, place). Only written
-- while the app is open, and only the parts a profile needs.
CREATE TABLE IF NOT EXISTS automation_device (
  owner_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
