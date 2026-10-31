-- Board templates (M9) and dashboards (M12). Additive only: new tables.

CREATE TABLE IF NOT EXISTS board_templates (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_board_templates_owner ON board_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_board_templates_business ON board_templates(business_id);

-- A dashboard belongs to one person (personal) or is shared with everyone who can see its boards.
CREATE TABLE IF NOT EXISTS dashboards (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  board_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(owner_id);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id SERIAL PRIMARY KEY,
  dashboard_id INTEGER NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('numbers', 'chart', 'battery', 'status', 'workload', 'upcoming', 'text', 'overdue')),
  title VARCHAR(120) NOT NULL DEFAULT '',
  config JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  width SMALLINT NOT NULL DEFAULT 1 CHECK (width BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_dashboard ON dashboard_widgets(dashboard_id);

-- Speed (M14): the lookups boards and My work make on every load.
CREATE INDEX IF NOT EXISTS idx_todos_board_section ON todos(board_id, business_section_id);
CREATE INDEX IF NOT EXISTS idx_todos_assignee_open ON todos(assignee_id) WHERE NOT is_done;
CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id);
CREATE INDEX IF NOT EXISTS idx_item_values_todo ON item_values(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_blockers_by_todo ON todo_blockers(blocked_by_todo_id) WHERE blocked_by_todo_id IS NOT NULL;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['board_templates', 'dashboards', 'dashboard_widgets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_archive_deleted BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION archive_deleted_row()', t);
  END LOOP;
END $$;
