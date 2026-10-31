const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor } = require('../utils/org');
const { listTodos } = require('../services/todoQueries');
const { boardsFor } = require('../services/boards');
const { todayInAppZone } = require('../utils/recurrence');
const { computeWidget } = require('../utils/dashboard');

/**
 * /api/dashboards (MONDAY_FEATURE_SPEC.md F-DSH): pages of widgets over one or more boards.
 *   GET    /                    mine and the shared ones
 *   POST   /                    { name, board_ids, shared? }
 *   PATCH  /:id                 { name?, board_ids?, shared?, archived? }   (owner only)
 *   GET    /:id/data            the dashboard, its widgets and each widget's data for the viewer
 *   POST   /:id/widgets         { kind, title?, config?, width? }            (owner only)
 *   PATCH  /:id/widgets/:wid    { title?, config?, width? }
 *   DELETE /:id/widgets/:wid
 *   PUT    /:id/widgets/order   { ids }
 * A widget only ever counts items the viewer can see, so a shared dashboard never shows anyone more than they may.
 */
const router = express.Router();
const KINDS = ['numbers', 'chart', 'battery', 'status', 'workload', 'upcoming', 'text', 'overdue'];
const int = (v) => (Number.isInteger(v) ? v : parseInt(v, 10) || null);

async function withActor(req, res, next) {
  try {
    req.actor = await loadActor(req.user.id);
    if (!req.actor) return res.status(401).json({ error: 'User not found' });
    next();
  } catch (err) {
    next(err);
  }
}

async function dashboardFor(req, res, { own = false } = {}) {
  const d = (await db.query('SELECT * FROM dashboards WHERE id = $1 AND archived_at IS NULL', [int(req.params.id)])).rows[0];
  if (!d || (d.owner_id !== req.actor.id && !d.shared)) { res.status(404).json({ error: 'Dashboard not found' }); return null; }
  if (own && d.owner_id !== req.actor.id) { res.status(403).json({ error: 'Only the person who made this dashboard can change it' }); return null; }
  return d;
}

function cleanConfig(raw = {}) {
  const c = {};
  if (!raw || typeof raw !== 'object') return c;
  if (['all', 'open', 'done', 'overdue', 'mine', 'this_week'].includes(raw.filter)) c.filter = raw.filter;
  if (['status', 'person', 'board', 'priority'].includes(raw.by)) c.by = raw.by;
  if (raw.column) c.column = sanitizeText(raw.column, 120);
  if (raw.unit) c.unit = sanitizeText(raw.unit, 12);
  if (raw.text !== undefined) c.text = String(raw.text).slice(0, 2000);
  if (Number.isInteger(raw.limit)) c.limit = Math.min(Math.max(raw.limit, 1), 20);
  return c;
}

router.get('/', authenticate, withActor, async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT d.id, d.name, d.shared, d.board_ids, d.owner_id, u.name AS owner_name, d.updated_at
       FROM dashboards d JOIN users u ON u.id = d.owner_id
       WHERE d.archived_at IS NULL AND (d.owner_id = $1 OR d.shared) ORDER BY d.owner_id = $1 DESC, d.updated_at DESC`,
      [req.actor.id]
    )).rows;
    res.json({ dashboards: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticate, withActor, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Name the dashboard' });
    const visible = new Set((await boardsFor(req.actor)).map((b) => b.id));
    const boardIds = (Array.isArray(req.body.board_ids) ? req.body.board_ids : []).map(int).filter((id) => visible.has(id)).slice(0, 50);
    const d = (await db.query(
      'INSERT INTO dashboards (owner_id, name, shared, board_ids) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.actor.id, name, !!req.body.shared, boardIds]
    )).rows[0];
    // A new dashboard starts with a useful first row.
    const starters = [
      ['numbers', 'Open items', { filter: 'open' }, 1], ['numbers', 'Overdue', { filter: 'overdue' }, 1], ['battery', 'Done', {}, 1],
      ['status', 'By stage', {}, 2], ['workload', 'Who carries what', {}, 1], ['upcoming', 'Coming up', {}, 2], ['overdue', 'Late', {}, 1],
    ];
    for (const [i, [kind, title, config, width]] of starters.entries()) {
      await db.query('INSERT INTO dashboard_widgets (dashboard_id, kind, title, config, sort_order, width) VALUES ($1, $2, $3, $4, $5, $6)', [d.id, kind, title, config, i + 1, width]);
    }
    res.status(201).json({ dashboard: d });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)', authenticate, withActor, async (req, res, next) => {
  try {
    const d = await dashboardFor(req, res, { own: true });
    if (!d) return;
    let boardIds = d.board_ids;
    if (Array.isArray(req.body.board_ids)) {
      const visible = new Set((await boardsFor(req.actor)).map((b) => b.id));
      boardIds = req.body.board_ids.map(int).filter((id) => visible.has(id)).slice(0, 50);
    }
    const updated = (await db.query(
      `UPDATE dashboards SET name = $2, shared = $3, board_ids = $4, updated_at = NOW(),
              archived_at = CASE WHEN $5::boolean THEN NOW() ELSE archived_at END WHERE id = $1 RETURNING *`,
      [d.id, req.body.name !== undefined ? sanitizeText(req.body.name, 120) || d.name : d.name,
        req.body.shared !== undefined ? !!req.body.shared : d.shared, boardIds, !!req.body.archived]
    )).rows[0];
    res.json({ dashboard: updated });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/data', authenticate, withActor, async (req, res, next) => {
  try {
    const d = await dashboardFor(req, res);
    if (!d) return;
    const widgets = (await db.query('SELECT * FROM dashboard_widgets WHERE dashboard_id = $1 ORDER BY sort_order, id', [d.id])).rows;
    // Only the boards this viewer can open count, whoever made the dashboard.
    const mine = await boardsFor(req.actor);
    const boards = mine.filter((b) => d.board_ids.includes(b.id));
    const ids = boards.map((b) => b.id);
    const items = ids.length
      ? await listTodos(req.actor.id, { actor: req.actor, where: `t.board_id = ANY($5::int[]) AND (NOT t.is_done OR t.done_at > NOW() - INTERVAL '90 days')`, params: [ids] })
      : [];
    const values = {};
    const columnIdsByTitle = new Map();
    if (items.length) {
      const cols = (await db.query(`SELECT id, title FROM board_columns WHERE board_id = ANY($1::int[]) AND archived_at IS NULL AND kind IN ('numbers') AND COALESCE(settings->>'view', 'everyone') = 'everyone'`, [ids])).rows;
      for (const c of cols) {
        const k = c.title.toLowerCase();
        columnIdsByTitle.set(k, [...(columnIdsByTitle.get(k) || []), c.id]);
      }
      if (cols.length) {
        const v = await db.query('SELECT todo_id, column_id, value FROM item_values WHERE column_id = ANY($1::int[]) AND todo_id = ANY($2::int[])', [cols.map((c) => c.id), items.map((t) => t.id)]);
        for (const r of v.rows) { if (!values[r.todo_id]) values[r.todo_id] = {}; values[r.todo_id][r.column_id] = r.value; }
      }
    }
    const today = todayInAppZone();
    const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    const ctx = { today, weekEnd, meId: req.actor.id, boards: new Map(boards.map((b) => [b.id, b.name])), values, columnIdsByTitle };
    res.json({
      dashboard: { ...d, mine: d.owner_id === req.actor.id },
      boards: boards.map((b) => ({ id: b.id, name: b.name })),
      number_columns: [...columnIdsByTitle.keys()],
      widgets: widgets.map((w) => ({ ...w, data: computeWidget(w.kind, w.config, items, ctx) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/widgets', authenticate, withActor, async (req, res, next) => {
  try {
    const d = await dashboardFor(req, res, { own: true });
    if (!d) return;
    if (!KINDS.includes(req.body.kind)) return res.status(400).json({ error: 'Pick a widget' });
    const order = (await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM dashboard_widgets WHERE dashboard_id = $1', [d.id])).rows[0].n;
    const w = (await db.query(
      'INSERT INTO dashboard_widgets (dashboard_id, kind, title, config, sort_order, width) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [d.id, req.body.kind, sanitizeText(req.body.title, 120) || '', cleanConfig(req.body.config), order, Math.min(Math.max(int(req.body.width) || 1, 1), 3)]
    )).rows[0];
    res.status(201).json({ widget: w });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id(\\d+)/widgets/:wid(\\d+)', authenticate, withActor, async (req, res, next) => {
  try {
    const d = await dashboardFor(req, res, { own: true });
    if (!d) return;
    const w = (await db.query('SELECT * FROM dashboard_widgets WHERE id = $1 AND dashboard_id = $2', [int(req.params.wid), d.id])).rows[0];
    if (!w) return res.status(404).json({ error: 'Widget not found' });
    const updated = (await db.query(
      'UPDATE dashboard_widgets SET title = $2, config = $3, width = $4 WHERE id = $1 RETURNING *',
      [w.id, req.body.title !== undefined ? sanitizeText(req.body.title, 120) || '' : w.title,
        req.body.config !== undefined ? cleanConfig(req.body.config) : w.config,
        req.body.width !== undefined ? Math.min(Math.max(int(req.body.width) || 1, 1), 3) : w.width]
    )).rows[0];
    res.json({ widget: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)/widgets/:wid(\\d+)', authenticate, withActor, async (req, res, next) => {
  try {
    const d = await dashboardFor(req, res, { own: true });
    if (!d) return;
    await db.query('DELETE FROM dashboard_widgets WHERE id = $1 AND dashboard_id = $2', [int(req.params.wid), d.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id(\\d+)/widgets/order', authenticate, withActor, async (req, res, next) => {
  try {
    const d = await dashboardFor(req, res, { own: true });
    if (!d) return;
    const list = (Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean);
    for (const [i, id] of list.entries()) await db.query('UPDATE dashboard_widgets SET sort_order = $1 WHERE id = $2 AND dashboard_id = $3', [i + 1, id, d.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
