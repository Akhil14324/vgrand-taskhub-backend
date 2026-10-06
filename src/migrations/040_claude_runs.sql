-- "Run with Claude": a person clicks a button on a to-do that mentions @claude, a GitHub Actions
-- workflow does the work on a branch and opens a pull request, and a senior person approves (merges)
-- or rejects (closes) it from the app. One row per run.
CREATE TABLE IF NOT EXISTS claude_runs (
  id SERIAL PRIMARY KEY,
  -- The to-do may be deleted later; the run (and its pull request) stays as history.
  todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
  todo_title VARCHAR(500) NOT NULL,
  repo_key VARCHAR(20) NOT NULL,          -- 'mobile' | 'backend' (see CLAUDE_REPOS)
  repo VARCHAR(200) NOT NULL,             -- owner/name
  -- queued -> running -> pr_ready -> merged | rejected ; or failed / no_changes
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  branch VARCHAR(200),
  pr_number INTEGER,
  pr_url TEXT,
  summary TEXT,
  triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_claude_runs_todo ON claude_runs(todo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claude_runs_open ON claude_runs(status) WHERE status IN ('queued', 'running', 'pr_ready');
