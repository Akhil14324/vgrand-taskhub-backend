-- Collaboration: comment threads, reactions, file attachments and the daily stand-up.

-- A reply points at the comment it answers (one level deep: replies to a reply join the same thread).
ALTER TABLE todo_comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES todo_comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_todo_comments_parent ON todo_comments(parent_id) WHERE parent_id IS NOT NULL;

-- Reactions are icons, not emoji; `kind` is one of a short list the API checks.
CREATE TABLE IF NOT EXISTS todo_comment_reactions (
  comment_id INTEGER NOT NULL REFERENCES todo_comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS todo_reactions (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (todo_id, user_id, kind)
);

-- Files on a to-do. `comment_id` is set when the file belongs to a comment; `draft` marks a file
-- uploaded for a comment that has not been posted yet.
CREATE TABLE IF NOT EXISTS todo_attachments (
  id SERIAL PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES todo_comments(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  filename VARCHAR(255) NOT NULL DEFAULT 'file',
  mime VARCHAR(120),
  size_bytes INTEGER,
  draft BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo ON todo_attachments(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_attachments_comment ON todo_attachments(comment_id) WHERE comment_id IS NOT NULL;

-- One stand-up per person per day. The lists are snapshots ([{id, title}]) so they stay readable later.
CREATE TABLE IF NOT EXISTS standups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  done JSONB NOT NULL DEFAULT '[]',
  doing JSONB NOT NULL DEFAULT '[]',
  blockers JSONB NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_standups_day ON standups(day);
