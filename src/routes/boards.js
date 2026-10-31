const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { listTodos, getTodoFor } = require('../services/todoQueries');
const { canCreateBoard } = require('../utils/boardAccess');
const { isLeader: isLeaderActor } = require('../utils/org');
const {
  PALETTE, KINDS, SYSTEM_COLUMNS, VIEW_KINDS, STATUS_KEYS, COLOR_NAMES, cleanValue, cleanSettings,
} = require('../utils/columns');
const {
  addSystemColumn, addStatusLabels, ensureBoardDefaults, boardFor, boardAudience, boardsFor,
} = require('../services/boards');
const { createTodoCore, announce } = require('./todos');
const { logEvent } = require('../services/todoTimeline');
const { computeFormulas, computeMirrors, plainValue } = require('../utils/boardCompute');
const { configured: aiConfigured, chatJSON } = require('../utils/openai');
const { BUILT_INS, checkDefinition } = require('../utils/boardTemplates');
const { definitionFromBoard, buildBoard } = require('../services/boardBuild');
const columnsCatalog = require('../utils/columns');
const { recipeList, buildRecipe, isBoardProfile } = require('../utils/boardRecipes');

/**
 * Boards (migration 055), mounted at /api/boards. See MONDAY_FEATURE_SPEC.md sections 2–5.
 *
 *   GET    /catalog                               column types, built-in columns, palette, view kinds
 *   GET    /                                      boards the viewer may see
 *   POST   /                                      { scope, business_id?, site_id?, name, ... }
 *   GET    /:id                                   board, columns, labels, groups, views, items, values
 *   PATCH  /:id                                   { name?, description?, icon?, color?, privacy?, item_word?, archived? }
 *   POST   /:id/columns                           { kind, title?, system_key?, settings?, after? }
 *   PATCH  /:id/columns/:cid                      { title?, description?, width?, settings? }
 *   PUT    /:id/columns/order                     { ids: [...] }
 *   DELETE /:id/columns/:cid                      archive (values stay)
 *   POST   /:id/columns/:cid/labels               { label, color, maps_to? }
 *   PATCH  /:id/columns/:cid/labels/:lid          { label?, color?, maps_to? }
 *   PUT    /:id/columns/:cid/labels/order         { ids }
 *   DELETE /:id/columns/:cid/labels/:lid          archive
 *   POST   /:id/groups                            { name, color?, position? }
 *   PATCH  /:id/groups/:gid                       { name?, color?, archived? }
 *   PUT    /:id/groups/order                      { ids }
 *   POST   /:id/items                             { title, group_id?, parent_id?, values? , ...to-do fields }
 *   PUT    /:id/items/:todoId/values/:cid         { value }  custom columns only
 *   POST   /:id/views  PATCH /:id/views/:vid  PUT /:id/views/order  DELETE /:id/views/:vid
 *   PUT    /:id/members                           { user_id, role }
 *   DELETE /:id/members/:userId
 *
 * Built-in columns are changed through the existing to-do endpoints (catalog `system_columns[key].edit`),
 * so every rule, timeline entry and notification of the to-do model still applies.
 */
const router = express.Router();

const SCOPES = ['group', 'business', 'site', 'personal'];
const PRIVACY = ['main', 'private', 'shareable'];
const ROLES = ['viewer', 'editor', 'admin'];

async function withActor(req, res, next) {
  try {
    req.actor = await loadActor(req.user.id);
    if (!req.actor) return res.status(401).json({ error: 'User not found' });
    next();
  } catch (err) {
    next(err);
  }
}

/** Loads the board for the route and checks the needed access ('view', 'add' or 'manage'). */
function boardParam(need) {
  return async (req, res, next) => {
    try {
      const found = await boardFor(req.params.id, req.actor);
      if (!found) return res.status(404).json({ error: 'Board not found' });
      if (!found.access[need]) {
        return res.status(403).json({ error: need === 'manage' ? 'Only the people who run this board can change it' : 'You cannot add to this board' });
      }
      req.board = found.board;
      req.boardAccess = found.access;
      req.boardMembers = found.members;
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function changed(board, what, extra = {}) {
  emitToUsers(await boardAudience(board), 'board:changed', { boardId: board.id, what, ...extra });
}

const color = (c, fallback = null) => (COLOR_NAMES.includes(c) ? c : fallback);
const int = (v) => (Number.isInteger(v) ? v : parseInt(v, 10) || null);

async function columnOf(req, res) {
  const col = (await db.query(
    'SELECT * FROM board_columns WHERE id = $1 AND board_id = $2', [int(req.params.cid), req.board.id]
  )).rows[0];
  if (!col) res.status(404).json({ error: 'Column not found' });
  return col || null;
}

async function reorder(table, ids, where, params) {
  const list = (Array.isArray(ids) ? ids : []).map(int).filter(Boolean);
  for (const [i, id] of list.entries()) {
    await db.query(`UPDATE ${table} SET sort_order = $1 WHERE id = $2 AND ${where}`, [i + 1, id, ...params]);
  }
  return list.length;
}

// ---------------------------------------------------------------------------
// Catalog and boards
// ---------------------------------------------------------------------------

router.get('/catalog', authenticate, (req, res) => {
  res.json({
    kinds: KINDS,
    system_columns: SYSTEM_COLUMNS,
    palette: PALETTE,
    view_kinds: VIEW_KINDS,
    status_keys: STATUS_KEYS,
  });
});

// ---------------------------------------------------------------------------
// Templates, duplicate, import (M9)
// ---------------------------------------------------------------------------

/** Where a new board goes, checked: { scope, business_id, site_id } -> { place } or { error, status }. */
async function placementFrom(actor, body) {
  const scope = SCOPES.includes(body.scope) ? body.scope : 'personal';
  let businessId = null;
  let siteId = null;
  if (scope === 'site') {
    siteId = int(body.site_id);
    const site = siteId ? (await db.query('SELECT id, business_id FROM sites WHERE id = $1 AND archived_at IS NULL', [siteId])).rows[0] : null;
    if (!site) return { status: 404, error: 'Site not found' };
    businessId = site.business_id;
  } else if (scope === 'business') {
    businessId = int(body.business_id);
    if (!businessId || !(await db.query('SELECT 1 FROM businesses WHERE id = $1', [businessId])).rows.length) return { status: 404, error: 'Business not found' };
  }
  if (!canCreateBoard(actor, scope, businessId)) return { status: 403, error: 'You cannot add boards here' };
  return { place: { scope, business_id: businessId, site_id: siteId, privacy: PRIVACY.includes(body.privacy) ? body.privacy : undefined } };
}

// GET /templates — ready-made ones, the person's own, and those of their businesses.
router.get('/templates', authenticate, withActor, async (req, res, next) => {
  try {
    const mine = (await db.query(
      `SELECT t.id, t.name, t.description, t.business_id, b.name AS business_name, t.owner_id, t.created_at
       FROM board_templates t LEFT JOIN businesses b ON b.id = t.business_id
       WHERE t.archived_at IS NULL AND (t.owner_id = $1 OR t.business_id = ANY($2::int[]) OR $3::boolean)
       ORDER BY t.created_at DESC LIMIT 200`,
      [req.actor.id, [...req.actor.memberships.keys()], isLeaderActor(req.actor)]
    )).rows;
    res.json({
      ready_made: Object.entries(BUILT_INS).map(([key, t]) => ({ key, name: t.name, description: t.description, sector: t.sector })),
      saved: mine,
    });
  } catch (err) {
    next(err);
  }
});

// POST /templates — { board_id, name, description?, with_items?: 'none' | 'all' | 'open', for_business? } save a board's shape.
router.post('/templates', authenticate, withActor, async (req, res, next) => {
  try {
    const found = await boardFor(req.body.board_id, req.actor);
    if (!found) return res.status(404).json({ error: 'Board not found' });
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Name the template' });
    const def = await definitionFromBoard(found.board, req.actor, ['all', 'open'].includes(req.body.with_items) ? req.body.with_items : 'none');
    const businessId = req.body.for_business && found.board.business_id && found.access.manage ? found.board.business_id : null;
    const row = (await db.query(
      'INSERT INTO board_templates (owner_id, business_id, name, description, definition) VALUES ($1, $2, $3, $4, $5) RETURNING id, name',
      [req.actor.id, businessId, name, sanitizeText(req.body.description, 1000) || '', def]
    )).rows[0];
    res.status(201).json({ template: row });
  } catch (err) {
    next(err);
  }
});

// POST /from-template — { key? (ready-made) | template_id?, name, scope, business_id?, site_id?, privacy?, with_items? }
router.post('/from-template', authenticate, withActor, async (req, res, next) => {
  try {
    let def;
    let fallbackName;
    if (req.body.key && BUILT_INS[req.body.key]) {
      def = BUILT_INS[req.body.key].definition;
      fallbackName = BUILT_INS[req.body.key].name;
    } else {
      const t = (await db.query(
        'SELECT * FROM board_templates WHERE id = $1 AND archived_at IS NULL AND (owner_id = $2 OR business_id = ANY($3::int[]) OR $4::boolean)',
        [int(req.body.template_id), req.actor.id, [...req.actor.memberships.keys()], isLeaderActor(req.actor)]
      )).rows[0];
      if (!t) return res.status(404).json({ error: 'Template not found' });
      def = t.definition;
      fallbackName = t.name;
    }
    const problems = checkDefinition(def, columnsCatalog);
    if (problems.length) return res.status(400).json({ error: `This template cannot be used: ${problems[0]}` });
    const p = await placementFrom(req.actor, req.body);
    if (p.error) return res.status(p.status).json({ error: p.error });
    const name = sanitizeText(req.body.name, 120) || fallbackName;
    const out = await buildBoard(req.actor, { ...p.place, name }, def, { withItems: req.body.with_items !== false, createTodoCore });
    await changed(out.board, 'created');
    res.status(201).json({ board: out.board, items: out.items });
  } catch (err) {
    next(err);
  }
});

// POST /:id/duplicate — { name?, with_items?: 'none' | 'all' | 'open' } a new board in the same place; the original is untouched.
router.post('/:id(\\d+)/duplicate', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const b = req.board;
    if (!canCreateBoard(req.actor, b.scope, b.business_id)) return res.status(403).json({ error: 'You cannot add boards here' });
    const withItems = ['all', 'open'].includes(req.body.with_items) ? req.body.with_items : 'none';
    const def = await definitionFromBoard(b, req.actor, withItems);
    const name = sanitizeText(req.body.name, 120) || `${b.name} (copy)`;
    const out = await buildBoard(req.actor, { scope: b.scope, business_id: b.business_id, site_id: b.site_id, privacy: b.privacy, name, description: b.description },
      def, { withItems: withItems !== 'none', createTodoCore });
    await changed(out.board, 'created');
    res.status(201).json({ board: out.board, items: out.items });
  } catch (err) {
    next(err);
  }
});

// POST /:id/groups/:gid/duplicate — { with_items? } a copy of a group right below it (new items, the old ones stay).
router.post('/:id(\\d+)/groups/:gid(\\d+)/duplicate', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    const g = (await db.query('SELECT * FROM todo_sections WHERE id = $1 AND board_id = $2', [int(req.params.gid), req.board.id])).rows[0];
    if (!g) return res.status(404).json({ error: 'Group not found' });
    await db.query('UPDATE todo_sections SET sort_order = sort_order + 1 WHERE board_id = $1 AND sort_order > $2', [req.board.id, g.sort_order]);
    const copy = (await db.query(
      `INSERT INTO todo_sections (list_id, owner_id, business_id, board_id, name, description, sort_order, color)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id, name, color, sort_order`,
      [req.actor.id, req.board.business_id, req.board.id, `${g.name} (copy)`.slice(0, 120), g.description || '', g.sort_order + 1, g.color]
    )).rows[0];
    let made = 0;
    if (req.body.with_items) {
      const items = await listTodos(req.actor.id, { actor: req.actor, where: 't.board_id = $5 AND t.business_section_id = $6 AND t.parent_id IS NULL AND NOT t.is_done', params: [req.board.id, g.id], tail: 'LIMIT 200' });
      for (const t of items) {
        const out = await createTodoCore(req.actor, {
          title: t.title, notes: t.notes || '', priority: t.priority, due_date: t.due_date || undefined, start_date: t.start_date || undefined,
          board_id: req.board.business_id ? req.board.id : undefined, business_id: req.board.business_id || undefined,
          business_section_id: req.board.business_id ? copy.id : undefined, assign_to: t.assignee_id || undefined,
        }, { quiet: true });
        const id = out.todo?.id || out.id;
        if (!id) continue;
        made += 1;
        if (!req.board.business_id) await db.query('UPDATE todos SET board_id = $1, business_section_id = $2 WHERE id = $3', [req.board.id, copy.id, id]);
        await db.query(`INSERT INTO item_values (todo_id, column_id, value, updated_by) SELECT $1, column_id, value, $3 FROM item_values WHERE todo_id = $2 ON CONFLICT DO NOTHING`, [id, t.id, req.actor.id]);
      }
    }
    await changed(req.board, 'groups');
    res.status(201).json({ group: copy, items: made });
  } catch (err) {
    next(err);
  }
});

// POST /:id/import — { rows: [{ title, group?, due_date?, priority?, values?: { [column title]: raw } }], dry_run? }
// Creates new items only (it never updates an existing one). A dry run answers what would happen.
router.post('/:id(\\d+)/import', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    const rows = (Array.isArray(req.body.rows) ? req.body.rows : []).slice(0, 5000);
    if (!rows.length) return res.status(400).json({ error: 'Nothing to import' });
    const cols = (await db.query('SELECT * FROM board_columns WHERE board_id = $1 AND archived_at IS NULL AND system_key IS NULL', [req.board.id])).rows;
    const groups = (await db.query('SELECT id, name FROM todo_sections WHERE board_id = $1 AND NOT archived ORDER BY sort_order', [req.board.id])).rows;
    const existing = new Set((await db.query('SELECT lower(title) AS t FROM todos WHERE board_id = $1', [req.board.id])).rows.map((r) => r.t));
    const byTitle = new Map(cols.map((c) => [c.title.toLowerCase(), c]));
    const labelMaps = new Map();
    for (const c of cols.filter((x) => x.kind === 'status')) {
      labelMaps.set(c.id, new Map((await db.query('SELECT id, lower(label) AS l FROM status_labels WHERE column_id = $1 AND archived_at IS NULL', [c.id])).rows.map((r) => [r.l, r.id])));
    }
    const plan = rows.map((r, i) => {
      const title = sanitizeText(r.title, 500);
      const problems = [];
      if (!title) problems.push('no name');
      const values = {};
      for (const [k, raw] of Object.entries(r.values || {})) {
        const col = byTitle.get(String(k).toLowerCase());
        if (!col || raw === '' || raw === null || raw === undefined) continue;
        let v = raw;
        if (col.kind === 'status') v = { label_id: labelMaps.get(col.id)?.get(String(raw).toLowerCase()) };
        if (col.kind === 'dropdown') {
          const opt = (col.settings?.options || []).find((o) => o.label.toLowerCase() === String(raw).toLowerCase());
          v = opt ? [opt.id] : '__none__';
        }
        const cleaned = cleanValue(col.kind, v, col.settings || {}, col.kind === 'status' ? { labelIds: [...(labelMaps.get(col.id)?.values() || [])] } : {});
        if (cleaned.error) problems.push(`${col.title}: ${cleaned.error}`); else values[col.id] = cleaned.value;
      }
      const group = r.group ? groups.find((g) => g.name.toLowerCase() === String(r.group).toLowerCase()) : null;
      return { row: i + 1, title, values, group_id: group?.id || groups[0]?.id || null, due_date: r.due_date, priority: r.priority, duplicate: existing.has((title || '').toLowerCase()), problems };
    });
    const summary = { rows: plan.length, ok: plan.filter((p) => !p.problems.length).length, with_problems: plan.filter((p) => p.problems.length).length, duplicates: plan.filter((p) => p.duplicate).length };
    if (req.body.dry_run) return res.json({ summary, problems: plan.filter((p) => p.problems.length).slice(0, 50).map((p) => ({ row: p.row, problems: p.problems })), duplicates: plan.filter((p) => p.duplicate).slice(0, 50).map((p) => ({ row: p.row, title: p.title })) });
    let made = 0;
    const skipDuplicates = req.body.skip_duplicates !== false;
    for (const p of plan) {
      if (p.problems.length || (skipDuplicates && p.duplicate)) continue;
      const out = await createTodoCore(req.actor, {
        title: p.title, due_date: p.due_date || undefined, priority: p.priority || undefined,
        board_id: req.board.business_id ? req.board.id : undefined, business_id: req.board.business_id || undefined,
        business_section_id: req.board.business_id ? p.group_id : undefined,
      }, { quiet: true });
      const id = out.todo?.id || out.id;
      if (!id) continue;
      made += 1;
      if (!req.board.business_id) await db.query('UPDATE todos SET board_id = $1, business_section_id = $2 WHERE id = $3', [req.board.id, p.group_id, id]);
      for (const [cid, v] of Object.entries(p.values)) {
        if (v === null) continue;
        await db.query('INSERT INTO item_values (todo_id, column_id, value, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [id, Number(cid), JSON.stringify(v), req.actor.id]);
      }
    }
    await changed(req.board, 'groups');
    res.status(201).json({ summary, created: made });
  } catch (err) {
    next(err);
  }
});

router.get('/', authenticate, withActor, async (req, res, next) => {
  try {
    res.json({ boards: await boardsFor(req.actor) });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, withActor, async (req, res, next) => {
  try {
    const actor = req.actor;
    const scope = SCOPES.includes(req.body.scope) ? req.body.scope : 'personal';
    let businessId = null;
    let siteId = null;
    if (scope === 'site') {
      siteId = int(req.body.site_id);
      const site = siteId ? (await db.query('SELECT id, business_id FROM sites WHERE id = $1 AND archived_at IS NULL', [siteId])).rows[0] : null;
      if (!site) return res.status(404).json({ error: 'Site not found' });
      businessId = site.business_id;
    } else if (scope === 'business') {
      businessId = int(req.body.business_id);
      const biz = businessId ? (await db.query('SELECT id FROM businesses WHERE id = $1', [businessId])).rows[0] : null;
      if (!biz) return res.status(404).json({ error: 'Business not found' });
    }
    if (!canCreateBoard(actor, scope, businessId)) return res.status(403).json({ error: 'You cannot add boards here' });

    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Name the board' });
    const order = (await db.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM boards WHERE scope = $1 AND business_id IS NOT DISTINCT FROM $2',
      [scope, businessId]
    )).rows[0].n;
    const board = (await db.query(
      `INSERT INTO boards (scope, business_id, site_id, owner_id, name, description, icon, color, privacy, kind, item_word, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        scope, businessId, siteId, scope === 'personal' ? actor.id : null, name,
        sanitizeText(req.body.description, 2000) || '', sanitizeText(req.body.icon, 40) || 'grid-outline',
        color(req.body.color, 'blue'), PRIVACY.includes(req.body.privacy) ? req.body.privacy : (scope === 'personal' ? 'private' : 'main'),
        sanitizeText(req.body.kind, 20) || 'custom', sanitizeText(req.body.item_word, 30) || 'Item', order, actor.id,
      ]
    )).rows[0];
    await ensureBoardDefaults(db, board.id, actor.id);
    // A board starts with one group so the first item has somewhere to go.
    await db.query(
      `INSERT INTO todo_sections (list_id, owner_id, business_id, board_id, name, description, sort_order, color)
       VALUES (NULL, $1, $2, $3, $4, '', 1, 'blue')`,
      [actor.id, businessId, board.id, sanitizeText(req.body.first_group, 120) || 'Group 1']
    );
    await changed(board, 'created');
    res.status(201).json({ board });
  } catch (err) {
    next(err);
  }
});

/**
 * What fills itself on a board: formulas, mirrors (through Connect-boards links), the names and links of the
 * files in Files columns, and the titles of linked items so a Connect-boards cell can show them.
 */
async function computedValues({ items, columns, values, actor, ids }) {
  const names = new Map((await db.query('SELECT id, name FROM users')).rows.map((u) => [u.id, u.name]));
  const nameOf = (id) => names.get(Number(id)) || '';
  const cells = {};
  const merge = (out) => {
    for (const [todoId, row] of Object.entries(out)) cells[todoId] = { ...(cells[todoId] || {}), ...row };
  };
  merge(computeFormulas(items, columns, values, nameOf));

  // Linked items: only those the viewer can see come back.
  const relationCols = columns.filter((c) => c.kind === 'board_relation');
  const linkedIds = [...new Set(items.flatMap((t) => relationCols.flatMap((c) => values[t.id]?.[c.id] || [])))].slice(0, 500);
  let linked = { items: [], columns: [], values: {} };
  if (linkedIds.length) {
    const linkedItems = await listTodos(actor.id, { actor, where: 't.id = ANY($5::int[])', params: [linkedIds] });
    const boardIds = [...new Set(linkedItems.map((t) => t.board_id).filter(Boolean))];
    const [lcols, lvals] = await Promise.all([
      boardIds.length ? db.query('SELECT * FROM board_columns WHERE board_id = ANY($1::int[]) AND archived_at IS NULL', [boardIds]) : { rows: [] },
      db.query('SELECT todo_id, column_id, value FROM item_values WHERE todo_id = ANY($1::int[])', [linkedItems.map((t) => t.id)]),
    ]);
    const lv = {};
    for (const r of lvals.rows) { if (!lv[r.todo_id]) lv[r.todo_id] = {}; lv[r.todo_id][r.column_id] = r.value; }
    const lcolsVisible = lcols.rows.filter((c) => c.settings?.view !== 'managers');
    linked = { items: linkedItems, columns: lcolsVisible, values: lv };
    merge(computeMirrors(items, columns, values, linked, nameOf));
  }

  const fileIds = [...new Set(items.flatMap((t) => columns.filter((c) => c.kind === 'files').flatMap((c) => values[t.id]?.[c.id] || [])))];
  const attachments = {};
  if (fileIds.length) {
    const rows = (await db.query(
      'SELECT id, todo_id, url, filename, mime, size_bytes FROM todo_attachments WHERE id = ANY($1::int[]) AND todo_id = ANY($2::int[])',
      [fileIds, ids]
    )).rows;
    for (const r of rows) attachments[r.id] = r;
  }
  return {
    cells,
    attachments,
    linked: Object.fromEntries(linked.items.map((t) => [t.id, { id: t.id, title: t.title, board_id: t.board_id, is_done: t.is_done }])),
  };
}

router.get('/:id(\\d+)', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const board = req.board;
    const actor = req.actor;
    const [columns, labels, groups, views] = await Promise.all([
      db.query('SELECT * FROM board_columns WHERE board_id = $1 AND archived_at IS NULL ORDER BY sort_order, id', [board.id]),
      db.query(
        `SELECT l.* FROM status_labels l JOIN board_columns c ON c.id = l.column_id
         WHERE c.board_id = $1 AND l.archived_at IS NULL ORDER BY l.sort_order, l.id`,
        [board.id]
      ),
      db.query(
        'SELECT id, name, description, color, sort_order, archived FROM todo_sections WHERE board_id = $1 AND NOT archived ORDER BY sort_order, id',
        [board.id]
      ),
      db.query(
        `SELECT * FROM board_views WHERE board_id = $1 AND archived_at IS NULL AND (owner_id IS NULL OR owner_id = $2)
         ORDER BY sort_order, id`,
        [board.id, actor.id]
      ),
    ]);
    // Items: open ones, and finished ones from the last 60 days (older finished work stays in Completed / search).
    const items = await listTodos(actor.id, {
      actor,
      where: `t.board_id = $5 AND (NOT t.is_done OR t.done_at > NOW() - INTERVAL '60 days')`,
      params: [board.id],
      tail: 'ORDER BY t.business_section_id NULLS FIRST, COALESCE(bo.position, tm.sort_order, 0), t.created_at',
    });
    const ids = items.map((t) => t.id);
    const values = {};
    if (ids.length) {
      const v = await db.query('SELECT todo_id, column_id, value FROM item_values WHERE todo_id = ANY($1::int[])', [ids]);
      for (const row of v.rows) {
        if (!values[row.todo_id]) values[row.todo_id] = {};
        values[row.todo_id][row.column_id] = row.value;
      }
    }
    const labelsByColumn = {};
    for (const l of labels.rows) {
      if (!labelsByColumn[l.column_id]) labelsByColumn[l.column_id] = [];
      labelsByColumn[l.column_id].push(l);
    }
    // A column only the people who run the board may see is left out for everyone else, values included.
    const shown = columns.rows
      .filter((c) => c.settings?.view !== 'managers' || req.boardAccess.manage)
      .map((c) => ({ ...c, labels: labelsByColumn[c.id] || undefined }));
    const shownIds = new Set(shown.map((c) => c.id));
    for (const row of Object.values(values)) for (const cid of Object.keys(row)) if (!shownIds.has(Number(cid))) delete row[cid];

    const extra = await computedValues({ items, columns: shown, values, actor, ids });
    for (const [todoId, cells] of Object.entries(extra.cells)) values[todoId] = { ...(values[todoId] || {}), ...cells };

    res.json({
      board,
      access: req.boardAccess,
      members: req.boardMembers,
      columns: shown,
      groups: groups.rows,
      views: views.rows,
      items,
      values,
      attachments: extra.attachments,
      linked: extra.linked,
      ai_enabled: aiConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const b = req.board;
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : b.name;
    if (!name) return res.status(400).json({ error: 'Name the board' });
    if (b.is_default && req.body.archived) return res.status(400).json({ error: 'A business always keeps its main board' });
    const archived = req.body.archived === undefined ? null : !!req.body.archived;
    const updated = (await db.query(
      `UPDATE boards SET name = $2, description = $3, icon = $4, color = $5, privacy = $6, item_word = $7,
              sort_order = $8, updated_at = NOW(),
              archived_at = CASE WHEN $9::boolean IS NULL THEN archived_at WHEN $9 THEN COALESCE(archived_at, NOW()) ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [
        b.id, name,
        req.body.description !== undefined ? sanitizeText(req.body.description, 2000) || '' : b.description,
        req.body.icon !== undefined ? sanitizeText(req.body.icon, 40) || b.icon : b.icon,
        req.body.color !== undefined ? color(req.body.color, b.color) : b.color,
        PRIVACY.includes(req.body.privacy) && !(b.is_default && req.body.privacy === 'private') ? req.body.privacy : b.privacy,
        req.body.item_word !== undefined ? sanitizeText(req.body.item_word, 30) || 'Item' : b.item_word,
        Number.isInteger(req.body.sort_order) ? req.body.sort_order : b.sort_order,
        archived,
      ]
    )).rows[0];
    await changed(updated, 'board');
    res.json({ board: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Columns and labels
// ---------------------------------------------------------------------------

router.post('/:id(\\d+)/columns', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const board = req.board;
    const after = int(req.body.after);
    const max = (await db.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM board_columns WHERE board_id = $1', [board.id])).rows[0].n;
    let position = max + 1;
    if (after) {
      const a = (await db.query('SELECT sort_order FROM board_columns WHERE id = $1 AND board_id = $2', [after, board.id])).rows[0];
      if (a) {
        position = a.sort_order + 1;
        await db.query('UPDATE board_columns SET sort_order = sort_order + 1 WHERE board_id = $1 AND sort_order >= $2', [board.id, position]);
      }
    }
    let col;
    if (req.body.system_key) {
      if (!SYSTEM_COLUMNS[req.body.system_key]) return res.status(400).json({ error: 'Unknown built-in column' });
      col = await addSystemColumn(db, board.id, req.body.system_key, position, req.actor.id);
    } else {
      const kind = req.body.kind;
      if (!KINDS[kind] || KINDS[kind].system) return res.status(400).json({ error: 'Pick a column type' });
      const title = sanitizeText(req.body.title, 120) || KINDS[kind].label;
      col = (await db.query(
        `INSERT INTO board_columns (board_id, kind, title, width, sort_order, settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [board.id, kind, title, Math.min(Math.max(int(req.body.width) || 160, 60), 600), position, cleanSettings(kind, req.body.settings), req.actor.id]
      )).rows[0];
      if (kind === 'status') {
        await addStatusLabels(db, col.id, [
          { label: 'Not started', color: 'grey' }, { label: 'Working on it', color: 'orange' },
          { label: 'Stuck', color: 'red' }, { label: 'Done', color: 'green' },
        ]);
      }
    }
    const labels = (await db.query('SELECT * FROM status_labels WHERE column_id = $1 AND archived_at IS NULL ORDER BY sort_order', [col.id])).rows;
    await changed(board, 'columns');
    res.status(201).json({ column: { ...col, labels: labels.length ? labels : undefined } });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)/columns/:cid(\\d+)', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 120) : col.title;
    if (!title) return res.status(400).json({ error: 'Name the column' });
    const settings = req.body.settings !== undefined
      ? { ...(col.settings || {}), ...cleanSettings(col.kind, req.body.settings) }
      : col.settings;
    const updated = (await db.query(
      'UPDATE board_columns SET title = $2, description = $3, width = $4, settings = $5 WHERE id = $1 RETURNING *',
      [
        col.id, title,
        req.body.description !== undefined ? sanitizeText(req.body.description, 1000) || '' : col.description,
        req.body.width !== undefined ? Math.min(Math.max(int(req.body.width) || col.width, 60), 600) : col.width,
        settings,
      ]
    )).rows[0];
    await changed(req.board, 'columns');
    res.json({ column: updated });
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)/columns/order', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    await reorder('board_columns', req.body.ids, 'board_id = $3', [req.board.id]);
    await changed(req.board, 'columns');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Removing a column hides it; its values stay in item_values and come back if it is restored.
router.delete('/:id(\\d+)/columns/:cid(\\d+)', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    await db.query('UPDATE board_columns SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1', [col.id]);
    await changed(req.board, 'columns');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/columns/:cid(\\d+)/restore', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    if (col.system_key) {
      const clash = await db.query(
        'SELECT 1 FROM board_columns WHERE board_id = $1 AND system_key = $2 AND archived_at IS NULL AND id <> $3',
        [req.board.id, col.system_key, col.id]
      );
      if (clash.rows.length) return res.status(409).json({ error: 'This board already shows that column' });
    }
    await db.query('UPDATE board_columns SET archived_at = NULL WHERE id = $1', [col.id]);
    await changed(req.board, 'columns');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

async function labelOf(req, res, col) {
  const label = (await db.query('SELECT * FROM status_labels WHERE id = $1 AND column_id = $2', [int(req.params.lid), col.id])).rows[0];
  if (!label) res.status(404).json({ error: 'Label not found' });
  return label || null;
}

router.post('/:id(\\d+)/columns/:cid(\\d+)/labels', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    if (col.kind !== 'status') return res.status(400).json({ error: 'Only status columns have labels' });
    const label = sanitizeText(req.body.label, 60);
    if (!label) return res.status(400).json({ error: 'Name the label' });
    // On the built-in Status column every label stands for one stored status.
    const mapsTo = col.system_key === 'status'
      ? (STATUS_KEYS.includes(req.body.maps_to) ? req.body.maps_to : null)
      : null;
    if (col.system_key === 'status' && !mapsTo) return res.status(400).json({ error: 'Pick which stage this label means' });
    const order = (await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM status_labels WHERE column_id = $1', [col.id])).rows[0].n;
    const created = (await db.query(
      'INSERT INTO status_labels (column_id, label, color, maps_to, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [col.id, label, color(req.body.color, 'grey'), mapsTo, order]
    )).rows[0];
    await changed(req.board, 'columns');
    res.status(201).json({ label: created });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)/columns/:cid(\\d+)/labels/:lid(\\d+)', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    const label = await labelOf(req, res, col);
    if (!label) return;
    const text = req.body.label !== undefined ? sanitizeText(req.body.label, 60) : label.label;
    if (!text) return res.status(400).json({ error: 'Name the label' });
    const mapsTo = col.system_key === 'status' && STATUS_KEYS.includes(req.body.maps_to) ? req.body.maps_to : label.maps_to;
    const updated = (await db.query(
      'UPDATE status_labels SET label = $2, color = $3, maps_to = $4 WHERE id = $1 RETURNING *',
      [label.id, text, req.body.color !== undefined ? color(req.body.color, label.color) : label.color, mapsTo]
    )).rows[0];
    await changed(req.board, 'columns');
    res.json({ label: updated });
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)/columns/:cid(\\d+)/labels/order', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    await reorder('status_labels', req.body.ids, 'column_id = $3', [col.id]);
    await changed(req.board, 'columns');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)/columns/:cid(\\d+)/labels/:lid(\\d+)', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    const label = await labelOf(req, res, col);
    if (!label) return;
    if (col.system_key === 'status') {
      // Keep at least one label for each stage that is in use, or those items would have nothing to show.
      const others = await db.query(
        'SELECT 1 FROM status_labels WHERE column_id = $1 AND maps_to = $2 AND id <> $3 AND archived_at IS NULL',
        [col.id, label.maps_to, label.id]
      );
      const inUse = await db.query(
        'SELECT 1 FROM todos WHERE board_id = $1 AND status = $2 LIMIT 1', [req.board.id, label.maps_to]
      );
      if (!others.rows.length && inUse.rows.length) {
        return res.status(409).json({ error: 'Items are at this stage. Rename the label, or add another label for it first.' });
      }
    }
    await db.query('UPDATE status_labels SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1', [label.id]);
    await changed(req.board, 'columns');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Groups (todo_sections with board_id)
// ---------------------------------------------------------------------------

router.post('/:id(\\d+)/groups', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    const board = req.board;
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Name the group' });
    const position = int(req.body.position);
    let order;
    if (position) {
      await db.query('UPDATE todo_sections SET sort_order = sort_order + 1 WHERE board_id = $1 AND sort_order >= $2', [board.id, position]);
      order = position;
    } else {
      order = (await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM todo_sections WHERE board_id = $1', [board.id])).rows[0].n;
    }
    const group = (await db.query(
      `INSERT INTO todo_sections (list_id, owner_id, business_id, board_id, name, description, sort_order, color)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7) RETURNING id, name, description, color, sort_order, archived`,
      [req.actor.id, board.business_id, board.id, name, sanitizeText(req.body.description, 1000) || '', order, color(req.body.color, 'blue')]
    )).rows[0];
    await changed(board, 'groups');
    res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)/groups/:gid(\\d+)', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    const group = (await db.query('SELECT * FROM todo_sections WHERE id = $1 AND board_id = $2', [int(req.params.gid), req.board.id])).rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    // Renaming and recolouring is for anyone who fills the board; archiving a group is for those who run it.
    if (req.body.archived !== undefined && !req.boardAccess.manage) return res.status(403).json({ error: 'Only the people who run this board can archive groups' });
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : group.name;
    if (!name) return res.status(400).json({ error: 'Name the group' });
    const updated = (await db.query(
      `UPDATE todo_sections SET name = $2, color = $3, description = $4, archived = $5 WHERE id = $1
       RETURNING id, name, description, color, sort_order, archived`,
      [
        group.id, name, req.body.color !== undefined ? color(req.body.color, group.color) : group.color,
        req.body.description !== undefined ? sanitizeText(req.body.description, 1000) || '' : group.description,
        req.body.archived !== undefined ? !!req.body.archived : group.archived,
      ]
    )).rows[0];
    await changed(req.board, 'groups');
    res.json({ group: updated });
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)/groups/order', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    await reorder('todo_sections', req.body.ids, 'board_id = $3', [req.board.id]);
    await changed(req.board, 'groups');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Items and custom values
// ---------------------------------------------------------------------------

/** Column ids and the context cleanValue needs to check a value against this board. */
async function valueContext(board, col) {
  const ctx = {};
  if (col.kind === 'status') {
    ctx.labelIds = (await db.query('SELECT id FROM status_labels WHERE column_id = $1 AND archived_at IS NULL', [col.id])).rows.map((r) => r.id);
  }
  if (col.kind === 'person' && board.business_id) {
    ctx.userIds = (await db.query(
      `SELECT user_id AS id FROM user_businesses WHERE business_id = $1
       UNION SELECT id FROM users WHERE status != 'inactive' AND (org_level IS NOT NULL OR role IN ('admin', 'super_admin'))
       UNION SELECT user_id FROM board_members WHERE board_id = $2`,
      [board.business_id, board.id]
    )).rows.map((r) => r.id);
  }
  return ctx;
}

async function writeValue(board, col, todoId, raw, userId) {
  const cleaned = cleanValue(col.kind, raw, col.settings || {}, await valueContext(board, col));
  if (cleaned.error) return cleaned;
  if (cleaned.value === null) {
    await db.query('DELETE FROM item_values WHERE todo_id = $1 AND column_id = $2', [todoId, col.id]);
  } else {
    await db.query(
      `INSERT INTO item_values (todo_id, column_id, value, updated_by, updated_at) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (todo_id, column_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [todoId, col.id, JSON.stringify(cleaned.value), userId]
    );
  }
  return cleaned;
}

router.post('/:id(\\d+)/items', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    const board = req.board;
    const groupId = int(req.body.group_id);
    if (groupId) {
      const ok = await db.query('SELECT 1 FROM todo_sections WHERE id = $1 AND board_id = $2 AND NOT archived', [groupId, board.id]);
      if (!ok.rows.length) return res.status(404).json({ error: 'Group not found' });
    }
    const body = {
      ...req.body,
      board_id: req.body.parent_id ? undefined : board.id,
      business_id: board.business_id || undefined,
      business_section_id: board.business_id ? groupId : undefined,
      // A personal / group board item stays on the creator's own list unless people are named.
      mention_ids: req.body.mention_ids,
    };
    const result = await createTodoCore(req.actor, body);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    const todoId = result.todo?.id || result.id;
    if (!board.business_id && groupId && todoId) {
      await db.query('UPDATE todos SET business_section_id = $1 WHERE id = $2', [groupId, todoId]);
    }
    // Custom values given with the new item ({ columnId: value }); built-in fields go in the body above.
    const errors = {};
    if (todoId && req.body.values && typeof req.body.values === 'object') {
      const cols = (await db.query('SELECT * FROM board_columns WHERE board_id = $1 AND archived_at IS NULL AND system_key IS NULL', [board.id])).rows;
      for (const col of cols) {
        if (req.body.values[col.id] === undefined) continue;
        const r = await writeValue(board, col, todoId, req.body.values[col.id], req.actor.id);
        if (r.error) errors[col.id] = r.error;
      }
    }
    const todo = todoId ? await getTodoFor(todoId, req.actor.id, req.actor) : null;
    // createTodoCore announced the new item; say it again only if its group or values were set after that.
    if (todoId && ((!board.business_id && groupId) || req.body.values)) await announce(todoId, 'updated');
    res.status(201).json({ todo, id: todoId, assigned_to: result.assigned_to, value_errors: Object.keys(errors).length ? errors : undefined });
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)/items/:todoId(\\d+)/values/:cid(\\d+)', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const col = await columnOf(req, res);
    if (!col) return;
    if (col.archived_at) return res.status(404).json({ error: 'Column not found' });
    if (col.system_key) return res.status(400).json({ error: 'Change this column through the item itself' });
    if (col.settings?.view === 'managers' && !req.boardAccess.manage) return res.status(404).json({ error: 'Column not found' });
    if (col.settings?.edit === 'managers' && !req.boardAccess.manage) {
      return res.status(403).json({ error: 'Only the people who run this board can change this column' });
    }
    const todo = await getTodoFor(req.params.todoId, req.actor.id, req.actor);
    if (!todo || todo.board_id !== req.board.id) return res.status(404).json({ error: 'Item not found' });
    // A vote is everyone's own: { vote: true | false } adds or takes back the voter's vote only.
    if (col.kind === 'vote') {
      if (!req.boardAccess.view) return res.status(403).json({ error: 'You cannot vote here' });
      const had = (await db.query('SELECT value FROM item_values WHERE todo_id = $1 AND column_id = $2', [todo.id, col.id])).rows[0]?.value || [];
      const voters = req.body.vote === false ? had.filter((id) => id !== req.actor.id) : [...new Set([...had, req.actor.id])];
      const r = await writeValue(req.board, col, todo.id, voters, req.actor.id);
      await announce(todo.id, 'updated');
      return res.json({ value: r.value });
    }
    if (!(todo.permissions.can_change_status || todo.permissions.can_edit)) {
      return res.status(403).json({ error: 'You cannot change this item' });
    }
    let raw = req.body.value;
    if (col.kind === 'files' && Array.isArray(raw) && raw.length) {
      // Only files attached to this item (POST /api/collab/todos/:id/attachments) can sit in its Files cell.
      raw = (await db.query('SELECT id FROM todo_attachments WHERE todo_id = $1 AND id = ANY($2::int[]) AND NOT draft', [todo.id, raw.map(Number).filter(Boolean)])).rows.map((r) => r.id);
    }
    if (col.kind === 'board_relation' && Array.isArray(raw) && raw.length) {
      // Only items the person can see, and on the column's board when it names one.
      const wanted = raw.map(Number).filter(Boolean).slice(0, 50);
      const seen = await listTodos(req.actor.id, { actor: req.actor, where: 't.id = ANY($5::int[])', params: [wanted] });
      raw = seen.filter((t) => t.id !== todo.id && (!col.settings?.board_id || t.board_id === col.settings.board_id)).map((t) => t.id);
    }
    const r = await writeValue(req.board, col, todo.id, raw, req.actor.id);
    if (r.error) return res.status(400).json({ error: r.error });
    await db.query('UPDATE todos SET updated_at = NOW() WHERE id = $1', [todo.id]);
    await logEvent({ todoId: todo.id, userId: req.actor.id, subjectId: todo.assignee_id, kind: 'value_changed', note: col.title, meta: { column_id: col.id } });
    await announce(todo.id, 'updated');
    res.json({ value: r.value });
  } catch (err) {
    next(err);
  }
});

// GET /:id/automations — the board's recipe gallery and the viewer's own automations on this board (F-AUT-01).
router.get('/:id(\\d+)/automations', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT p.id, p.name, p.enabled, p.contexts, p.created_at,
              (SELECT COUNT(*)::int FROM automation_runs r WHERE r.profile_id = p.id AND r.started_at > NOW() - INTERVAL '30 days') AS runs_30d
       FROM automation_profiles p WHERE p.owner_id = $1 ORDER BY p.created_at DESC`,
      [req.actor.id]
    )).rows;
    res.json({ recipes: recipeList(), mine: rows.filter((p) => isBoardProfile(p.contexts, req.board.id)).map(({ contexts, ...p }) => p) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/automations — { recipe, params } add a recipe for this board, owned (and run) by the person adding it.
router.post('/:id(\\d+)/automations', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const built = buildRecipe(String(req.body.recipe || ''), req.board, req.body.params || {});
    if (built.error) return res.status(400).json({ error: built.error });
    const { createFromDoc } = require('./automation');
    const made = await createFromDoc(req.actor, built, { enabled: true });
    if (made.error) return res.status(400).json({ error: made.error });
    res.status(201).json({ profile_id: made.profileId });
  } catch (err) {
    next(err);
  }
});

// GET /:id/activity — { before? } the board's history (F-VIW-13): todo_events of the items the viewer can see,
// newest first, 100 at a time. Survives deleted items (their title stays in the event).
router.get('/:id(\\d+)/activity', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const visible = await listTodos(req.actor.id, { actor: req.actor, where: 't.board_id = $5', params: [req.board.id] });
    const ids = visible.map((t) => t.id);
    if (!ids.length) return res.json({ events: [] });
    const before = parseInt(req.query.before, 10) || null;
    const rows = (await db.query(
      `SELECT e.id, e.todo_id, e.kind, e.from_value, e.to_value, e.note, e.created_at,
              u.name AS user_name, s.name AS subject_name, t.title AS todo_title
       FROM todo_events e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN users s ON s.id = e.subject_id
       LEFT JOIN todos t ON t.id = e.todo_id
       WHERE e.todo_id = ANY($1::int[]) AND ($2::int IS NULL OR e.id < $2)
       ORDER BY e.id DESC LIMIT 100`,
      [ids, before]
    )).rows;
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

// GET /:id/dependencies — "this item waits for that one" pairs among the board's items (Gantt arrows).
router.get('/:id(\\d+)/dependencies', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const visible = await listTodos(req.actor.id, { actor: req.actor, where: 't.board_id = $5', params: [req.board.id] });
    const ids = visible.map((t) => t.id);
    if (!ids.length) return res.json({ links: [] });
    const rows = (await db.query(
      `SELECT todo_id, blocked_by_todo_id, resolved_at IS NOT NULL AS resolved FROM todo_blockers
       WHERE kind = 'dependency' AND todo_id = ANY($1::int[]) AND blocked_by_todo_id = ANY($1::int[])`,
      [ids]
    )).rows;
    res.json({ links: rows.map((r) => ({ from: r.blocked_by_todo_id, to: r.todo_id, resolved: r.resolved })) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/columns/:cid/ai-fill — { item_ids } fill an AI column from its source columns (OpenAI only, F-MORE-01).
const AI_PROMPTS = {
  summarize: 'Summarise the item in one short plain sentence.',
  categorize: 'Pick the single best category for the item. Answer with the category only.',
  extract: 'Extract the requested detail from the item. Answer with the detail only, or "-" if it is not there.',
  translate: 'Translate the item into English if it is in Telugu, or into Telugu if it is in English. Answer with the translation only.',
  sentiment: 'Say whether the item sounds positive, neutral or negative, in one word.',
  reply: 'Write a short, polite reply to the item, in two sentences at most.',
  custom: 'Do what the instruction asks with the item.',
};
router.post('/:id(\\d+)/columns/:cid(\\d+)/ai-fill', authenticate, withActor, boardParam('add'), async (req, res, next) => {
  try {
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is not set up on the server' });
    const col = await columnOf(req, res);
    if (!col) return;
    if (col.kind !== 'ai') return res.status(400).json({ error: 'This is not an AI column' });
    const wanted = (Array.isArray(req.body.item_ids) ? req.body.item_ids : []).map(Number).filter(Boolean).slice(0, 50);
    const items = await listTodos(req.actor.id, { actor: req.actor, where: 't.board_id = $5 AND t.id = ANY($6::int[])', params: [req.board.id, wanted] });
    const cols = (await db.query('SELECT * FROM board_columns WHERE board_id = $1 AND archived_at IS NULL', [req.board.id])).rows;
    const sources = cols.filter((c) => (col.settings?.source_column_ids || []).includes(c.id));
    const vals = {};
    for (const r of (await db.query('SELECT todo_id, column_id, value FROM item_values WHERE todo_id = ANY($1::int[])', [items.map((t) => t.id)])).rows) {
      if (!vals[r.todo_id]) vals[r.todo_id] = {};
      vals[r.todo_id][r.column_id] = r.value;
    }
    const action = col.settings?.action || 'summarize';
    const out = {};
    for (const t of items) {
      if (!(t.permissions.can_change_status || t.permissions.can_edit)) continue;
      const lines = [`Item: ${t.title}`, t.notes ? `Notes: ${String(t.notes).slice(0, 2000)}` : null,
        ...sources.map((c) => `${c.title}: ${String(plainValue(t, c, vals)).slice(0, 2000)}`)].filter(Boolean);
      const reply = await chatJSON({
        system: `${AI_PROMPTS[action] || AI_PROMPTS.summarize} ${col.settings?.instruction ? `Instruction: ${col.settings.instruction}. ` : ''}`
          + 'Reply as JSON: {"text":"..."}',
        user: lines.join('\n'),
        maxTokens: 400,
      });
      const text = String(reply.text || '').trim().slice(0, 5000);
      const r = await writeValue(req.board, col, t.id, text || null, req.actor.id);
      if (!r.error) out[t.id] = r.value;
    }
    await changed(req.board, 'values');
    res.json({ values: out });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function cleanViewSettings(raw = {}) {
  const s = {};
  if (!raw || typeof raw !== 'object') return s;
  if (raw.filters !== undefined) s.filters = JSON.parse(JSON.stringify(raw.filters ?? null)) ?? undefined;
  for (const k of ['sort', 'hidden_columns', 'column_order', 'column_widths', 'card_columns', 'color_rules']) {
    if (raw[k] !== undefined) s[k] = JSON.parse(JSON.stringify(raw[k] ?? null)) ?? undefined;
  }
  for (const k of ['group_by', 'date_column', 'timeline_column', 'zoom', 'density', 'chart', 'search']) {
    if (raw[k] !== undefined && raw[k] !== null) s[k] = String(raw[k]).slice(0, 200);
  }
  if (raw.show_done !== undefined) s.show_done = !!raw.show_done;
  if (raw.collapsed_groups !== undefined && Array.isArray(raw.collapsed_groups)) s.collapsed_groups = raw.collapsed_groups.map(int).filter(Boolean).slice(0, 500);
  const size = JSON.stringify(s).length;
  return size > 20000 ? {} : s;
}

async function viewOf(req, res) {
  const view = (await db.query('SELECT * FROM board_views WHERE id = $1 AND board_id = $2', [int(req.params.vid), req.board.id])).rows[0];
  if (!view || (view.owner_id && view.owner_id !== req.actor.id)) { res.status(404).json({ error: 'View not found' }); return null; }
  // A shared view is shaped by the people who run the board; a personal one by its owner.
  if (!view.owner_id && !req.boardAccess.manage) { res.status(403).json({ error: 'Only the people who run this board can change shared views' }); return null; }
  return view;
}

router.post('/:id(\\d+)/views', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const kind = VIEW_KINDS.includes(req.body.kind) ? req.body.kind : null;
    if (!kind) return res.status(400).json({ error: 'Pick a view type' });
    const personal = req.body.personal !== false || !req.boardAccess.manage;
    const order = (await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM board_views WHERE board_id = $1', [req.board.id])).rows[0].n;
    const view = (await db.query(
      'INSERT INTO board_views (board_id, owner_id, kind, name, settings, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.board.id, personal ? req.actor.id : null, kind, sanitizeText(req.body.name, 80) || kind, cleanViewSettings(req.body.settings), order]
    )).rows[0];
    if (!personal) await changed(req.board, 'views');
    res.status(201).json({ view });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)/views/:vid(\\d+)', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const view = await viewOf(req, res);
    if (!view) return;
    const updated = (await db.query(
      'UPDATE board_views SET name = $2, settings = $3 WHERE id = $1 RETURNING *',
      [
        view.id, req.body.name !== undefined ? sanitizeText(req.body.name, 80) || view.name : view.name,
        req.body.settings !== undefined ? { ...(view.settings || {}), ...cleanViewSettings(req.body.settings) } : view.settings,
      ]
    )).rows[0];
    if (!view.owner_id) await changed(req.board, 'views');
    res.json({ view: updated });
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)/views/order', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    await reorder('board_views', req.body.ids, 'board_id = $3', [req.board.id]);
    await changed(req.board, 'views');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)/views/:vid(\\d+)', authenticate, withActor, boardParam('view'), async (req, res, next) => {
  try {
    const view = await viewOf(req, res);
    if (!view) return;
    const left = await db.query('SELECT COUNT(*)::int AS n FROM board_views WHERE board_id = $1 AND archived_at IS NULL AND owner_id IS NULL', [req.board.id]);
    if (!view.owner_id && left.rows[0].n <= 1) return res.status(400).json({ error: 'A board keeps at least one shared view' });
    await db.query('UPDATE board_views SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1', [view.id]);
    if (!view.owner_id) await changed(req.board, 'views');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Members (private boards, personal boards shared with others, guests)
// ---------------------------------------------------------------------------

router.put('/:id(\\d+)/members', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const userId = int(req.body.user_id);
    const role = ROLES.includes(req.body.role) ? req.body.role : 'editor';
    const person = userId ? (await db.query(`SELECT id FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0] : null;
    if (!person) return res.status(404).json({ error: 'Person not found' });
    await db.query(
      `INSERT INTO board_members (board_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.board.id, userId, role, req.actor.id]
    );
    await changed(req.board, 'members');
    emitToUsers([userId], 'board:changed', { boardId: req.board.id, what: 'members' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)/members/:userId(\\d+)', authenticate, withActor, boardParam('manage'), async (req, res, next) => {
  try {
    const userId = int(req.params.userId);
    await db.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [req.board.id, userId]);
    await changed(req.board, 'members');
    emitToUsers([userId], 'board:changed', { boardId: req.board.id, what: 'members' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
