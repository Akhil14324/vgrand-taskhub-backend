-- AI Assistant: a short log of what each person did with the assistant (questions asked, suggestions and reports
-- made, changes they confirmed), shown as "Recent AI activity". New table only; nothing existing changes.
CREATE TABLE IF NOT EXISTS assistant_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assistant_activity_user_idx ON assistant_activity (user_id, created_at DESC);
