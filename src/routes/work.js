const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor, isLeader, managesBusiness } = require('../utils/org');
const { listTodos } = require('../services/todoQueries');
const { boardsFor } = require('../services/boards');
const { announce } = require('./todos');

/**
 * Work management (MONDAY_FEATURE_SPEC.md M8):
 *   GET  /api/work/search?q=          items (title, description, comments), boards and people the viewer can see
 *   GET  /api/work/recycle            deleted to-dos the viewer may bring back (last 90 days)
 *   POST /api/work/recycle/:id/restore  bring one back with everything deleted with it
 *
 * The recycle bin reads deleted_rows (migration 054): every row removed from a main table, cascades included,
 * kept as JSON with the transaction it went in. Restoring puts back every row of that transaction that belongs to
 * the to-do (its sub-tasks, people, comments, files, blockers, values), parents first; rows whose id is taken
 * again are skipped, and nothing existing is overwritten.
 */
const router = express.Router();

async function withActor(req, res, next) {
  try {
    req.actor = await loadActor(req.user.id);
    if (!req.actor) return res.status(401).json({ error: 'User not found' });
    next();
  } catch (err) {
    next(err);
  }
}

const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

router.get('/search', authenticate, withActor, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 2) return res.json({ items: [], boards: [], people: [] });
    const actor = req.actor;
    const [items, boards, people] = await Promise.all([
      listTodos(actor.id, {
        actor,
        where: `(t.title ILIKE $5 OR t.notes ILIKE $5 OR EXISTS (SELECT 1 FROM todo_comments c WHERE c.todo_id = t.id AND c.body ILIKE $5))`,
        params: [like(q)],
        tail: 'ORDER BY t.is_done, t.updated_at DESC LIMIT 30',
      }),
      boardsFor(actor),
      db.query(
        `SELECT id, name, username, profile_picture FROM users
         WHERE status != 'inactive' AND (name ILIKE $1 OR username ILIKE $1) ORDER BY name LIMIT 10`,
        [like(q)]
      ),
    ]);
    const lower = q.toLowerCase();
    res.json({
      items: items.map((t) => ({
        id: t.id, title: t.title, is_done: t.is_done, status: t.status, board_id: t.board_id,
        business_name: t.business_name, due_date: t.due_date, assignee_name: t.assignee_name,
      })),
      boards: boards.filter((b) => b.name.toLowerCase().includes(lower) || (b.business_name || '').toLowerCase().includes(lower))
        .slice(0, 10).map((b) => ({ id: b.id, name: b.name, business_name: b.business_name, scope: b.scope })),
      people: people.rows,
    });
  } catch (err) {
    next(err);
  }
});

/** May this person bring back a deleted to-do (its JSON as archived)? Its creator, leadership, or its business's managers. */
function mayRestore(actor, data) {
  if (Number(data.created_by) === actor.id || isLeader(actor)) return true;
  return !!data.business_id && managesBusiness(actor, Number(data.business_id));
}

router.get('/recycle', authenticate, withActor, async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT d.id, d.txid, d.deleted_at, d.data,
              (SELECT COUNT(*)::int FROM deleted_rows s WHERE s.txid = d.txid AND s.table_name = 'todos' AND s.id <> d.id) AS with_subtasks,
              b.name AS business_name
       FROM deleted_rows d
       LEFT JOIN businesses b ON b.id = (d.data->>'business_id')::int
       WHERE d.table_name = 'todos' AND d.restored_at IS NULL AND d.deleted_at > NOW() - INTERVAL '90 days'
         -- top of what went: its parent was not deleted in the same transaction
         AND NOT EXISTS (SELECT 1 FROM deleted_rows p WHERE p.txid = d.txid AND p.table_name = 'todos' AND p.row_id = d.data->>'parent_id')
         -- not back already (restored another way, or the id is in use)
         AND NOT EXISTS (SELECT 1 FROM todos t WHERE t.id = (d.data->>'id')::int)
       ORDER BY d.deleted_at DESC LIMIT 200`
    )).rows;
    res.json({
      items: rows.filter((r) => mayRestore(req.actor, r.data)).map((r) => ({
        id: r.id,
        todo_id: Number(r.data.id),
        title: r.data.title,
        business_name: r.business_name,
        deleted_at: r.deleted_at,
        with_subtasks: r.with_subtasks,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Tables restored with a to-do, in the order their references need (a to-do before what points at it).
const WITH_TODO = ['todos', 'todo_members', 'todo_comments', 'todo_attachments', 'todo_blockers', 'item_values', 'todo_step_reviews', 'todo_meetings', 'time_logs'];

router.post('/recycle/:id(\\d+)/restore', authenticate, withActor, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const top = (await client.query(`SELECT * FROM deleted_rows WHERE id = $1 AND table_name = 'todos' AND restored_at IS NULL`, [req.params.id])).rows[0];
    if (!top) return res.status(404).json({ error: 'Not in the recycle bin' });
    if (!mayRestore(req.actor, top.data)) return res.status(403).json({ error: 'Only the person who made it, its business\'s managers or leadership can bring it back' });

    const batch = (await client.query(
      `SELECT * FROM deleted_rows WHERE txid = $1 AND restored_at IS NULL AND table_name = ANY($2::text[]) ORDER BY id`,
      [top.txid, WITH_TODO]
    )).rows;
    // Only the deleted to-do's own tree, not other to-dos that happened to go in the same transaction.
    const tree = new Set([Number(top.data.id)]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of batch) {
        if (r.table_name === 'todos' && !tree.has(Number(r.data.id)) && tree.has(Number(r.data.parent_id))) { tree.add(Number(r.data.id)); grew = true; }
      }
    }
    const belongs = (r) => (r.table_name === 'todos' ? tree.has(Number(r.data.id)) : tree.has(Number(r.data.todo_id)));

    await client.query('BEGIN');
    const restored = [];
    // To-dos: parents before children (a child waits for its parent to be back).
    let pending = batch.filter((r) => r.table_name === 'todos' && belongs(r));
    const back = new Set();
    for (let pass = 0; pending.length && pass < 12; pass += 1) {
      const next = [];
      for (const r of pending) {
        const parent = r.data.parent_id ? Number(r.data.parent_id) : null;
        if (parent && !back.has(parent) && tree.has(parent)) { next.push(r); continue; }
        const ins = await client.query('INSERT INTO todos SELECT * FROM jsonb_populate_record(NULL::todos, $1) ON CONFLICT DO NOTHING RETURNING id', [r.data]);
        if (ins.rows.length) { back.add(Number(r.data.id)); restored.push(r.id); }
      }
      pending = next;
    }
    for (const t of WITH_TODO.slice(1)) {
      for (const r of batch.filter((x) => x.table_name === t && belongs(x))) {
        if (!back.has(Number(r.data.todo_id))) continue;
        await client.query('SAVEPOINT one');
        try {
          const ins = await client.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_record(NULL::${t}, $1) ON CONFLICT DO NOTHING RETURNING 1`, [r.data]);
          if (ins.rows.length) restored.push(r.id);
          await client.query('RELEASE SAVEPOINT one');
        } catch {
          // A row that points at something no longer there (a removed person, a gone column) stays in the bin.
          await client.query('ROLLBACK TO SAVEPOINT one');
        }
      }
    }
    if (restored.length) await client.query('UPDATE deleted_rows SET restored_at = NOW() WHERE id = ANY($1::bigint[])', [restored]);
    await client.query('COMMIT');
    for (const id of back) await announce(id, 'created');
    res.json({ restored_todos: back.size, restored_rows: restored.length, todo_id: Number(top.data.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
