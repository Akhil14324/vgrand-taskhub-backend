const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor } = require('../utils/org');
const { getTodoFor } = require('../services/todoQueries');
const { todayInAppZone } = require('../utils/recurrence');
const { suggestions, spawn } = require('../services/workflows');

// /api/workflows: repeating processes that start themselves (see jobs/workflows.js). Everyone manages their own.
const router = express.Router();
const RECURRENCES = ['daily', 'weekly', 'monthly'];

function cleanSteps(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((s) => ({
    title: sanitizeText(s.title, 300),
    assignee_id: parseInt(s.assignee_id, 10) || null,
    offset_days: Math.max(0, Math.min(365, parseInt(s.offset_days, 10) || 0)),
  })).filter((s) => s.title);
}

const withNames = async (rows) => {
  const ids = [...new Set(rows.flatMap((w) => (w.steps || []).map((s) => s.assignee_id)).filter(Boolean))];
  const names = ids.length ? new Map((await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[])', [ids])).rows.map((u) => [u.id, u.name])) : new Map();
  return rows.map((w) => ({ ...w, steps: (w.steps || []).map((s) => ({ ...s, assignee_name: s.assignee_id ? names.get(s.assignee_id) || null : null })) }));
};

router.get('/', authenticate, async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT w.id, w.name, w.steps, w.recurrence, to_char(w.next_run_date, 'YYYY-MM-DD') AS next_run_date, w.sequential, w.paused,
              w.last_run_at, w.business_id, b.name AS business_name
       FROM workflows w LEFT JOIN businesses b ON b.id = w.business_id WHERE w.owner_id = $1 ORDER BY w.created_at DESC`,
      [req.user.id]
    )).rows;
    res.json({ workflows: await withNames(rows) });
  } catch (err) {
    next(err);
  }
});

router.get('/suggestions', authenticate, async (req, res, next) => {
  try {
    res.json({ suggestions: await withNames(await suggestions(req.user.id)) });
  } catch (err) {
    next(err);
  }
});

async function insert(userId, body) {
  const name = sanitizeText(body.name, 200);
  const steps = cleanSteps(body.steps);
  if (!name) return { error: 'Give the workflow a name' };
  if (!steps.length) return { error: 'Add at least one step' };
  const recurrence = RECURRENCES.includes(body.recurrence) ? body.recurrence : 'monthly';
  const next = /^\d{4}-\d{2}-\d{2}$/.test(body.next_run_date || '') ? body.next_run_date : todayInAppZone();
  const businessId = parseInt(body.business_id, 10) || null;
  const row = (await db.query(
    `INSERT INTO workflows (owner_id, business_id, name, steps, recurrence, next_run_date, sequential)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, businessId, name, JSON.stringify(steps), recurrence, next, !!body.sequential]
  )).rows[0];
  return { id: row.id };
}

// POST /api/workflows — { name, steps: [{ title, assignee_id?, offset_days? }], recurrence, next_run_date?, sequential?, business_id? }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const out = await insert(req.user.id, req.body);
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ id: out.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/workflows/from-todo/:id — { recurrence, next_run_date?, sequential? } turns a to-do and its steps into a workflow.
router.post('/from-todo/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const todo = await getTodoFor(req.params.id, actor.id, actor);
    if (!todo) return res.status(404).json({ error: 'To-do not found' });
    const kids = (await db.query('SELECT title, assignee_id, due_date FROM todos WHERE parent_id = $1 ORDER BY id', [todo.id])).rows;
    if (!kids.length) return res.status(400).json({ error: 'Add the steps first, then make it a workflow' });
    const base = todo.due_date ? String(todo.due_date).slice(0, 10) : null;
    const steps = kids.map((k) => ({
      title: k.title,
      assignee_id: k.assignee_id,
      offset_days: base && k.due_date ? Math.max(0, Math.round((new Date(`${String(k.due_date).slice(0, 10)}T12:00:00Z`) - new Date(`${base}T12:00:00Z`)) / 86400000)) : 0,
    }));
    const name = sanitizeText(req.body.name, 200) || todo.title;
    const out = await insert(req.user.id, { ...req.body, name, steps, business_id: todo.business_id });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ id: out.id });
  } catch (err) {
    next(err);
  }
});

async function mine(req, res) {
  const row = (await db.query('SELECT * FROM workflows WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id])).rows[0];
  if (!row) res.status(404).json({ error: 'Workflow not found' });
  return row;
}

router.put('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const wf = await mine(req, res);
    if (!wf) return;
    const b = req.body;
    await db.query(
      `UPDATE workflows SET name = $2, recurrence = $3, next_run_date = $4, sequential = $5, paused = $6, steps = $7 WHERE id = $1`,
      [
        wf.id,
        b.name !== undefined ? sanitizeText(b.name, 200) || wf.name : wf.name,
        RECURRENCES.includes(b.recurrence) ? b.recurrence : wf.recurrence,
        /^\d{4}-\d{2}-\d{2}$/.test(b.next_run_date || '') ? b.next_run_date : wf.next_run_date,
        b.sequential !== undefined ? !!b.sequential : wf.sequential,
        b.paused !== undefined ? !!b.paused : wf.paused,
        b.steps !== undefined ? JSON.stringify(cleanSteps(b.steps)) : JSON.stringify(wf.steps),
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const wf = await mine(req, res);
    if (!wf) return;
    await db.query('DELETE FROM workflows WHERE id = $1', [wf.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/workflows/:id/run — start a round right now (does not move the schedule)
router.post('/:id(\\d+)/run', authenticate, async (req, res, next) => {
  try {
    const wf = await mine(req, res);
    if (!wf) return;
    const todo = await spawn({ ...wf, next_run_date: todayInAppZone() }, { advanceSchedule: false });
    res.json({ todo_id: todo ? todo.id : null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
