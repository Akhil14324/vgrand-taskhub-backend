const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { emitToUsers } = require('../utils/notify');
const { listTodos } = require('../services/todoQueries');

/**
 * The Dump (migration 063), mounted at /api/dump. A holding area for a person's own open to-dos: send everything
 * there to see the board clear, then bring each one back, plan it, or delete it from the Dump screen. Only the flag
 * on the person's own membership changes (todo_members.dumped_at): the to-do, its list, section and order are left
 * as they were, other people on a shared to-do still see it, and business tasks are never dumped. Leaders still see
 * a person's dumped to-dos in the Team monitor (the Dump is for clarity, not for hiding work).
 *
 *   GET  /               my dumped to-dos (with their sub-tasks), newest dump first
 *   POST /all            send every open personal to-do of mine to the Dump        -> { count, ids }
 *   POST /send           { ids } send these (and what is below them)                -> { count, ids }
 *   POST /restore        { ids } or { all: true } bring back (and what is below)   -> { count, ids }
 */
const router = express.Router();

/** Ids of these to-dos and everything below them. */
async function withDescendants(ids) {
  if (!ids.length) return [];
  const rows = (await db.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM todos WHERE id = ANY($1::int[])
       UNION
       SELECT c.id FROM todos c JOIN tree ON c.parent_id = tree.id
     ) SELECT id FROM tree`,
    [ids]
  )).rows;
  return rows.map((r) => r.id);
}

const clean = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => parseInt(x, 10)).filter(Boolean))].slice(0, 2000);

function told(userId) {
  // todoId 0: the app reloads the whole list (a dumped to-do must leave it, a restored one must come back).
  emitToUsers([userId], 'todo:changed', { todoId: 0, action: 'dump' });
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    const todos = await listTodos(req.user.id, {
      where: 't.business_id IS NULL', dumped: 'only',
      tail: 'ORDER BY tm.dumped_at DESC, t.created_at DESC LIMIT 1000',
    });
    res.json({ todos });
  } catch (err) {
    next(err);
  }
});

/** Dump these personal, open, top-level to-dos of the person (plus everything below them). */
async function send(userId, ids) {
  const tops = (await db.query(
    `SELECT t.id FROM todos t JOIN todo_members m ON m.todo_id = t.id AND m.user_id = $1
     WHERE t.id = ANY($2::int[]) AND t.business_id IS NULL AND t.parent_id IS NULL AND NOT t.is_done`,
    [userId, ids]
  )).rows.map((r) => r.id);
  const all = await withDescendants(tops);
  const done = await db.query(
    `UPDATE todo_members SET dumped_at = NOW() WHERE user_id = $1 AND todo_id = ANY($2::int[]) AND dumped_at IS NULL`,
    [userId, all]
  );
  return { count: tops.length, ids: tops, rows: done.rowCount };
}

router.post('/all', authenticate, async (req, res, next) => {
  try {
    const ids = (await db.query(
      `SELECT t.id FROM todos t JOIN todo_members m ON m.todo_id = t.id AND m.user_id = $1
       WHERE t.business_id IS NULL AND t.parent_id IS NULL AND NOT t.is_done AND m.dumped_at IS NULL`,
      [req.user.id]
    )).rows.map((r) => r.id);
    const out = await send(req.user.id, ids);
    told(req.user.id);
    res.json({ count: out.count, ids: out.ids });
  } catch (err) {
    next(err);
  }
});

router.post('/send', authenticate, async (req, res, next) => {
  try {
    const out = await send(req.user.id, clean(req.body.ids));
    if (out.count) told(req.user.id);
    res.json({ count: out.count, ids: out.ids });
  } catch (err) {
    next(err);
  }
});

router.post('/restore', authenticate, async (req, res, next) => {
  try {
    const wanted = req.body.all
      ? (await db.query('SELECT todo_id AS id FROM todo_members WHERE user_id = $1 AND dumped_at IS NOT NULL', [req.user.id])).rows.map((r) => r.id)
      : clean(req.body.ids);
    const tops = (await db.query(
      `SELECT t.id FROM todos t JOIN todo_members m ON m.todo_id = t.id AND m.user_id = $1 AND m.dumped_at IS NOT NULL
       WHERE t.id = ANY($2::int[]) AND (t.parent_id IS NULL OR $3::boolean)`,
      [req.user.id, wanted, !!req.body.all]
    )).rows.map((r) => r.id);
    const all = await withDescendants(tops);
    await db.query('UPDATE todo_members SET dumped_at = NULL WHERE user_id = $1 AND todo_id = ANY($2::int[])', [req.user.id, all]);
    if (tops.length) told(req.user.id);
    res.json({ count: tops.length, ids: tops });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
