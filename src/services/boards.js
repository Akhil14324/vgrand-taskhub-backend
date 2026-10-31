const db = require('../db');
const {
  SYSTEM_COLUMNS, DEFAULT_COLUMNS, DEFAULT_STATUS_LABELS, DEFAULT_VIEWS,
} = require('../utils/columns');
const { boardAccess } = require('../utils/boardAccess');

/**
 * Board helpers that need the database (migration 055). `q` is any pg-style query object (db, a client, or
 * the direct pool used by migrations).
 */

/** Add a built-in column (and, for Status, its labels) to a board. Returns the column row. */
async function addSystemColumn(q, boardId, key, sortOrder, createdBy = null) {
  const def = SYSTEM_COLUMNS[key];
  const existing = await q.query(
    'SELECT * FROM board_columns WHERE board_id = $1 AND system_key = $2 AND archived_at IS NULL',
    [boardId, key]
  );
  if (existing.rows.length) return existing.rows[0];
  const col = (await q.query(
    `INSERT INTO board_columns (board_id, kind, title, system_key, width, sort_order, settings, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [boardId, def.kind, def.title, key, def.width || 160, sortOrder, def.settings || {}, createdBy]
  )).rows[0];
  if (def.kind === 'status') await addStatusLabels(q, col.id);
  return col;
}

async function addStatusLabels(q, columnId, labels = DEFAULT_STATUS_LABELS) {
  for (const [i, l] of labels.entries()) {
    await q.query(
      'INSERT INTO status_labels (column_id, label, color, maps_to, sort_order) VALUES ($1, $2, $3, $4, $5)',
      [columnId, l.label, l.color, l.maps_to || null, i + 1]
    );
  }
}

/** A board with no columns yet gets the default columns, status labels and views. Idempotent. */
async function ensureBoardDefaults(q, boardId, createdBy = null) {
  const has = await q.query('SELECT 1 FROM board_columns WHERE board_id = $1 LIMIT 1', [boardId]);
  if (!has.rows.length) {
    for (const [i, key] of DEFAULT_COLUMNS.entries()) await addSystemColumn(q, boardId, key, i + 1, createdBy);
  }
  const views = await q.query('SELECT 1 FROM board_views WHERE board_id = $1 LIMIT 1', [boardId]);
  if (!views.rows.length) {
    for (const [i, v] of DEFAULT_VIEWS.entries()) {
      await q.query(
        'INSERT INTO board_views (board_id, owner_id, kind, name, settings, sort_order) VALUES ($1, NULL, $2, $3, $4, $5)',
        [boardId, v.kind, v.name, v.settings, i + 1]
      );
    }
  }
}

/** The business's default board (created if missing): where its tasks land when no board is named. */
async function defaultBoardFor(q, businessId) {
  const found = await q.query('SELECT id FROM boards WHERE business_id = $1 AND is_default', [businessId]);
  if (found.rows.length) return found.rows[0].id;
  const biz = (await q.query('SELECT id, name, color FROM businesses WHERE id = $1', [businessId])).rows[0];
  if (!biz) return null;
  const created = await q.query(
    `INSERT INTO boards (scope, business_id, name, kind, is_default, icon, color)
     VALUES ('business', $1, $2, 'business', TRUE, 'grid-outline', $3)
     ON CONFLICT (business_id) WHERE is_default DO NOTHING RETURNING id`,
    [biz.id, biz.name, biz.color]
  );
  const id = created.rows[0]?.id
    || (await q.query('SELECT id FROM boards WHERE business_id = $1 AND is_default', [businessId])).rows[0].id;
  await ensureBoardDefaults(q, id);
  return id;
}

/**
 * Runs with every migration pass: every business has its default board, every board has its defaults, and
 * business tasks and sections that have no board yet are placed on their business's default board. Touches
 * only the board columns (migration 055), never existing data.
 */
async function backfillBoards(q, { log = console.log } = {}) {
  const missing = await q.query(
    'SELECT id FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM boards x WHERE x.business_id = b.id AND x.is_default)'
  );
  for (const b of missing.rows) {
    await defaultBoardFor(q, b.id);
    log(`  + default board for business ${b.id}`);
  }
  const bare = await q.query(
    'SELECT id FROM boards b WHERE NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.board_id = b.id)'
  );
  for (const b of bare.rows) await ensureBoardDefaults(q, b.id);
  const unplaced = await q.query('SELECT 1 FROM todos WHERE board_id IS NULL AND business_id IS NOT NULL LIMIT 1');
  if (unplaced.rows.length) {
    // Placing a task on its board is not an edit: keep its updated_at (the trigger is paused meanwhile).
    await q.query('ALTER TABLE todos DISABLE TRIGGER update_todos_updated_at');
    try {
      await q.query(
        `UPDATE todos t SET board_id = bd.id FROM boards bd
         WHERE bd.business_id = t.business_id AND bd.is_default AND t.board_id IS NULL AND t.business_id IS NOT NULL`
      );
    } finally {
      await q.query('ALTER TABLE todos ENABLE TRIGGER update_todos_updated_at');
    }
  }
  await q.query(
    `UPDATE todo_sections s SET board_id = bd.id FROM boards bd
     WHERE bd.business_id = s.business_id AND bd.is_default AND s.board_id IS NULL AND s.business_id IS NOT NULL`
  );
}

async function loadBoard(boardId) {
  const id = parseInt(boardId, 10);
  if (!id) return null;
  return (await db.query('SELECT * FROM boards WHERE id = $1', [id])).rows[0] || null;
}

async function boardMembers(boardId) {
  return (await db.query(
    `SELECT bm.user_id, bm.role, u.name, u.username, u.profile_picture
     FROM board_members bm JOIN users u ON u.id = bm.user_id
     WHERE bm.board_id = $1 AND u.status != 'inactive' ORDER BY u.name`,
    [boardId]
  )).rows;
}

/** Board plus the actor's access to it, or null when they cannot see it. */
async function boardFor(boardId, actor) {
  const board = await loadBoard(boardId);
  if (!board) return null;
  const members = await boardMembers(board.id);
  const access = boardAccess(actor, board, members);
  if (!access.view) return null;
  return { board, members, access };
}

/** Everyone who should hear that a board changed shape. */
async function boardAudience(board) {
  if (board.scope === 'personal') {
    const r = await db.query('SELECT user_id FROM board_members WHERE board_id = $1', [board.id]);
    return [...new Set([board.owner_id, ...r.rows.map((x) => x.user_id)].filter(Boolean))];
  }
  const r = await db.query(
    `SELECT user_id FROM board_members WHERE board_id = $1
     UNION SELECT id FROM users WHERE status != 'inactive' AND (org_level IS NOT NULL OR role IN ('admin', 'super_admin'))
     UNION SELECT user_id FROM user_businesses WHERE business_id = $2 AND $3::boolean`,
    [board.id, board.business_id || 0, board.privacy !== 'private' && !!board.business_id]
  );
  return r.rows.map((x) => x.user_id);
}

/** Every board the actor may see, not archived, with their access. */
async function boardsFor(actor) {
  const rows = (await db.query(
    `SELECT b.*, s.name AS site_name, bz.name AS business_name,
            COALESCE((SELECT json_agg(json_build_object('user_id', bm.user_id, 'role', bm.role))
                      FROM board_members bm WHERE bm.board_id = b.id), '[]') AS member_rows
     FROM boards b
     LEFT JOIN sites s ON s.id = b.site_id
     LEFT JOIN businesses bz ON bz.id = b.business_id
     WHERE b.archived_at IS NULL
     ORDER BY b.scope, bz.sort_order NULLS FIRST, b.is_default DESC, b.sort_order, b.id`
  )).rows;
  const out = [];
  for (const r of rows) {
    const access = boardAccess(actor, r, r.member_rows);
    if (!access.view) continue;
    const { member_rows: _omit, ...board } = r;
    out.push({ ...board, access });
  }
  return out;
}

module.exports = {
  addSystemColumn,
  addStatusLabels,
  ensureBoardDefaults,
  defaultBoardFor,
  backfillBoards,
  loadBoard,
  boardMembers,
  boardFor,
  boardAudience,
  boardsFor,
};
