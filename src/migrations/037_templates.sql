-- Migration: 037_templates.sql
-- To-do templates: a saved tree of tasks and sub-tasks with due dates relative to a start day.
-- personal = only the owner, business = members of that business, company = everyone (leadership only).
CREATE TABLE IF NOT EXISTS todo_templates (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  scope VARCHAR(10) NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'business', 'company')),
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  tree JSONB NOT NULL DEFAULT '[]',
  item_count INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_templates_owner ON todo_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_todo_templates_business ON todo_templates(business_id) WHERE business_id IS NOT NULL;
