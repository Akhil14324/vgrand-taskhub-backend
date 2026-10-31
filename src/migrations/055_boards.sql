-- Boards (the board-platform model). Additive only: new tables, new nullable columns. An item on a board
-- is an existing todos row (todos.board_id); a board's groups are todo_sections rows (todo_sections.board_id),
-- so the existing section routes keep working. Built-in columns read and write the todos fields; custom
-- columns keep their values in item_values. Nothing is copied, so nothing can drift.

CREATE TABLE IF NOT EXISTS boards (
  id SERIAL PRIMARY KEY,
  scope VARCHAR(10) NOT NULL CHECK (scope IN ('group', 'business', 'site', 'personal')),
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon VARCHAR(40),
  color VARCHAR(20),
  privacy VARCHAR(10) NOT NULL DEFAULT 'main' CHECK (privacy IN ('main', 'private', 'shareable')),
  kind VARCHAR(20) NOT NULL DEFAULT 'custom',
  item_word VARCHAR(30) NOT NULL DEFAULT 'Item',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CHECK ((scope IN ('business', 'site')) = (business_id IS NOT NULL)),
  CHECK (scope <> 'site' OR site_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_boards_business ON boards(business_id);
CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards(owner_id);
-- One default board per business: where business tasks land when no board is named.
CREATE UNIQUE INDEX IF NOT EXISTS uq_boards_business_default ON boards(business_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS board_members (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL DEFAULT 'editor' CHECK (role IN ('viewer', 'editor', 'admin')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (board_id, user_id)
);

ALTER TABLE todos ADD COLUMN IF NOT EXISTS board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS start_date DATE;
CREATE INDEX IF NOT EXISTS idx_todos_board ON todos(board_id);

ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL;
ALTER TABLE todo_sections ADD COLUMN IF NOT EXISTS color VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_todo_sections_board ON todo_sections(board_id);

CREATE TABLE IF NOT EXISTS board_columns (
  id SERIAL PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL,
  title VARCHAR(120) NOT NULL,
  system_key VARCHAR(30),
  description TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 160,
  sort_order INTEGER NOT NULL DEFAULT 0,
  settings JSONB NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_board_columns_board ON board_columns(board_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_columns_system ON board_columns(board_id, system_key)
  WHERE system_key IS NOT NULL AND archived_at IS NULL;

-- Labels of a status column. On the built-in Status column every label maps to one of the six stored
-- status keys, so renaming or recolouring a label never changes stored data.
CREATE TABLE IF NOT EXISTS status_labels (
  id SERIAL PRIMARY KEY,
  column_id INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  label VARCHAR(60) NOT NULL,
  color VARCHAR(20) NOT NULL DEFAULT 'grey',
  maps_to VARCHAR(20) CHECK (maps_to IN ('todo', 'in_progress', 'blocked', 'in_review', 'on_hold', 'done')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_status_labels_column ON status_labels(column_id);

CREATE TABLE IF NOT EXISTS item_values (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  value JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (todo_id, column_id)
);
CREATE INDEX IF NOT EXISTS idx_item_values_column ON item_values(column_id);

CREATE TABLE IF NOT EXISTS board_views (
  id SERIAL PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('table', 'kanban', 'calendar', 'timeline', 'gantt', 'chart',
    'workload', 'map', 'form', 'gallery', 'summary', 'activity')),
  name VARCHAR(80) NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_board_views_board ON board_views(board_id);

-- One default board per business, holding its existing tasks and sections.
INSERT INTO boards (scope, business_id, name, kind, is_default, sort_order, icon, color)
SELECT 'business', b.id, b.name, 'business', TRUE, 0, 'grid-outline', b.color
FROM businesses b
WHERE NOT EXISTS (SELECT 1 FROM boards x WHERE x.business_id = b.id AND x.is_default);

-- Placing existing tasks on their board must not touch their "last updated" time, so the trigger that
-- stamps updated_at is paused for this one statement.
ALTER TABLE todos DISABLE TRIGGER update_todos_updated_at;
UPDATE todos t SET board_id = bd.id
FROM boards bd
WHERE bd.business_id = t.business_id AND bd.is_default AND t.board_id IS NULL AND t.business_id IS NOT NULL;
ALTER TABLE todos ENABLE TRIGGER update_todos_updated_at;

UPDATE todo_sections s SET board_id = bd.id
FROM boards bd
WHERE bd.business_id = s.business_id AND bd.is_default AND s.board_id IS NULL AND s.business_id IS NOT NULL;

-- Boards and their parts join the archive of deleted rows (migration 054).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['boards', 'board_members', 'board_columns', 'status_labels', 'item_values', 'board_views'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_archive_deleted BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION archive_deleted_row()', t);
  END LOOP;
END $$;
