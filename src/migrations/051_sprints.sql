-- Migration: 051_sprints.sql
-- Sprints: a time-boxed set of a business's tasks with a goal. A business task joins at most one sprint;
-- a sprint that is completed keeps its tasks' points so velocity can be read later. Additive only.

CREATE TABLE IF NOT EXISTS sprints (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  goal VARCHAR(300) NOT NULL DEFAULT '',
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS idx_sprints_business ON sprints(business_id, status);

-- At most one active sprint per business.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sprints_one_active ON sprints(business_id) WHERE status = 'active';

ALTER TABLE todos ADD COLUMN IF NOT EXISTS sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS story_points SMALLINT;
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_story_points_check;
ALTER TABLE todos ADD CONSTRAINT todos_story_points_check CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100);
CREATE INDEX IF NOT EXISTS idx_todos_sprint ON todos(sprint_id) WHERE sprint_id IS NOT NULL;
