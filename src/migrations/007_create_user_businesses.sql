-- Migration: 007_create_user_businesses.sql
-- Creates a junction table to allow users to be assigned to multiple businesses

CREATE TABLE IF NOT EXISTS user_businesses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, business_id)
);

CREATE INDEX IF NOT EXISTS idx_user_businesses_user_id ON user_businesses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_businesses_business_id ON user_businesses(business_id);

-- Migrate existing business_id assignments into the junction table
INSERT INTO user_businesses (user_id, business_id)
SELECT id, business_id FROM users WHERE business_id IS NOT NULL
ON CONFLICT DO NOTHING;
