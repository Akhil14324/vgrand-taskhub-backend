-- AI agents that may read a person's to-dos through /mcp (2026-11-28).
-- Only SHA-256 hashes of codes and tokens are stored. These tokens open /mcp and nothing else.

-- An agent app that registered itself (OAuth dynamic client registration).
CREATE TABLE IF NOT EXISTS agent_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A one-time sign-in code, alive for a minute.
CREATE TABLE IF NOT EXISTS agent_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES agent_clients(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- One connection of one agent to one person. Removing the row disconnects it.
CREATE TABLE IF NOT EXISTS agent_grants (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES agent_clients(id) ON DELETE CASCADE,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_refresh_hash TEXT,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_grants_user ON agent_grants(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_grants_previous ON agent_grants(previous_refresh_hash);

-- A new password (changed, reset by anyone) or a deactivated account disconnects every agent of that person,
-- whichever part of the app made the change.
CREATE OR REPLACE FUNCTION drop_agent_access() RETURNS trigger AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR (NEW.status = 'inactive' AND OLD.status IS DISTINCT FROM 'inactive') THEN
    DELETE FROM agent_codes WHERE user_id = NEW.id;
    DELETE FROM agent_grants WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_drop_agent_access ON users;
CREATE TRIGGER users_drop_agent_access AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION drop_agent_access();
