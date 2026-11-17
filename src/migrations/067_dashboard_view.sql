-- A board can show a Dashboard tab (widgets live in the view's settings). Additive: only the allowed kinds widen.
ALTER TABLE board_views DROP CONSTRAINT IF EXISTS board_views_kind_check;
ALTER TABLE board_views ADD CONSTRAINT board_views_kind_check CHECK (kind IN ('table', 'kanban', 'calendar', 'timeline', 'gantt', 'chart',
  'workload', 'map', 'form', 'gallery', 'summary', 'activity', 'dashboard'));

-- Every existing board gets a shared Dashboard tab (empty settings: the app builds the widgets from the board's
-- columns the first time it is opened). Insert only; nothing existing is touched.
INSERT INTO board_views (board_id, owner_id, kind, name, settings, sort_order)
SELECT b.id, NULL, 'dashboard', 'Dashboard', '{}',
       COALESCE((SELECT MAX(v.sort_order) FROM board_views v WHERE v.board_id = b.id), 0) + 1
FROM boards b
WHERE NOT EXISTS (SELECT 1 FROM board_views v WHERE v.board_id = b.id AND v.kind = 'dashboard');
