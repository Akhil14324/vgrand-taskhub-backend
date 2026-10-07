-- Migration: 041_access_sections_reminders.sql
-- Module permissions, explicit "who may watch whom", editable/archivable sections with descriptions,
-- favourites for lists / filters / labels, and one stand-alone repeating reminder per to-do.
-- Purely additive.

-- A switch for one module for one person. No row = the default for their level (utils/permissions.js).
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(40) NOT NULL,
  allowed BOOLEAN NOT NULL,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, permission)
);

-- Extra people a viewer may watch in the Team monitor, on top of the chain of command.
CREATE TABLE IF NOT EXISTS monitor_access (
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (viewer_id, target_id)
);

-- Sections: a description and an archive flag.
ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- Favourites: kind is 'list' | 'filter' | 'label'; ref is the id (as text) or the label name.
CREATE TABLE IF NOT EXISTS todo_favorites (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL,
  ref VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, kind, ref)
);

-- One stand-alone reminder per to-do: a date and time, optionally repeating every day / week / month.
-- After it fires, a repeating reminder moves to its next date; a one-off is marked sent.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_date DATE;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_time TIME;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_repeat VARCHAR(10);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS remind_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_todos_remind ON todos(remind_date) WHERE remind_date IS NOT NULL;
