-- AI Assistant: the conversation history. One row per chat, one per message, always owned by one person and only
-- ever read back for that person. New tables only; nothing existing changes.
CREATE TABLE IF NOT EXISTS assistant_chats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(120) NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assistant_chats_user_idx ON assistant_chats (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id SERIAL PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES assistant_chats(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  proposals JSONB,   -- changes the assistant proposed in this message, as shown to the person
  results JSONB,     -- what happened to them: [{ ok, message }] once the person said yes or no
  is_error BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assistant_messages_chat_idx ON assistant_messages (chat_id, id);
