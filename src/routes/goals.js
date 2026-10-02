const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify } = require('../utils/notify');
const { loadActor, isLeader, managesBusiness } = require('../utils/org');
const { todayInAppZone } = require('../utils/recurrence');
const { daysBetween } = require('../utils/templates');
const { getTodoFor } = require('../services/todoQueries');
const { keyResultProgress, goalProgress, goalPace } = require('../utils/insights');

const router = express.Router();

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SCOPES = ['company', 'business', 'personal'];
const MAX_KRS = 8;
const MAX_LINKS = 40;

/** Goals this person may see: the company's, their businesses', their own (leadership sees every business). */
const VISIBLE = `(
  g.scope = 'company'
  OR g.owner_id = $1
  OR (g.scope = 'business' AND ($2::boolean OR g.business_id IN (SELECT business_id FROM user_businesses WHERE user_id = $1)))
)`;

function canManage(actor, goal) {
  if (goal.owner_id === actor.id) return true;
  if (goal.scope === 'company') return isLeader(actor);
  if (goal.scope === 'business') return isLeader(actor) || managesBusiness(actor, goal.business_id);
  return false;
}

/** Whether this actor may create a goal of this scope; returns { scope, businessId } or { error, status }. */
function resolveScope(actor, body) {
  const scope = SCOPES.includes(body.scope) ? body.scope : 'personal';
  if (scope === 'personal') return { scope, businessId: null };
  if (scope === 'company') {
    if (!isLeader(actor)) return { error: 'Only leadership can set a company goal', status: 403 };
    return { scope, businessId: null };
  }
  const businessId = parseInt(body.business_id, 10) || null;
  if (!businessId) return { error: 'Choose a business', status: 400 };
  if (!isLeader(actor) && !managesBusiness(actor, businessId)) return { error: 'Only a manager of that business can set its goals', status: 403 };
  return { scope, businessId };
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

async function loadGoals(actor, extraWhere = '', extraParams = []) {
  const goals = (await db.query(
    `SELECT g.id, g.title, g.description, g.scope, g.business_id, b.name AS business_name, g.owner_id, u.name AS owner_name,
            g.starts_on, g.ends_on, g.status, g.created_at
     FROM goals g
     LEFT JOIN businesses b ON b.id = g.business_id
     LEFT JOIN users u ON u.id = g.owner_id
     WHERE ${VISIBLE} ${extraWhere}
     ORDER BY (g.status = 'active') DESC, g.ends_on ASC, g.id DESC`,
    [actor.id, isLeader(actor), ...extraParams]
  )).rows;
  if (!goals.length) return [];

  const krs = (await db.query(
    `SELECT k.id, k.goal_id, k.title, k.kind, k.unit, k.start_value, k.target_value, k.current_value, k.sort_order, k.updated_at,
            COALESCE(l.total, 0)::int AS todos_total, COALESCE(l.done, 0)::int AS todos_done
     FROM goal_key_results k
     LEFT JOIN (
       SELECT r.key_result_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE t.is_done) AS done
       FROM goal_key_result_todos r JOIN todos t ON t.id = r.todo_id
       GROUP BY r.key_result_id
     ) l ON l.key_result_id = k.id
     WHERE k.goal_id = ANY($1::int[])
     ORDER BY k.sort_order, k.id`,
    [goals.map((g) => g.id)]
  )).rows;

  const today = todayInAppZone();
  return goals.map((g) => {
    const mine = krs.filter((k) => k.goal_id === g.id).map((k) => ({
      ...k,
      start_value: Number(k.start_value),
      target_value: Number(k.target_value),
      current_value: Number(k.current_value),
      progress: Math.round(keyResultProgress(k) * 100),
    }));
    const progress = goalProgress(mine);
    return {
      ...g,
      key_results: mine,
      progress: Math.round(progress * 100),
      pace: g.status === 'achieved' ? 'done' : goalPace(progress, g.starts_on, g.ends_on, today, daysBetween),
      days_left: Math.max(0, daysBetween(today, g.ends_on)),
      can_manage: canManage(actor, g),
    };
  });
}

async function loadGoal(actor, id) {
  return (await loadGoals(actor, 'AND g.id = $3', [id]))[0] || null;
}

/** Links to-dos the actor can see to a "todos" key result (replaces what was there). */
async function setLinks(actor, krId, todoIds) {
  const wanted = [...new Set((todoIds || []).map((n) => parseInt(n, 10)).filter(Boolean))].slice(0, MAX_LINKS);
  const allowed = [];
  for (const id of wanted) {
    if (await getTodoFor(id, actor.id, actor)) allowed.push(id);
  }
  await db.query('DELETE FROM goal_key_result_todos WHERE key_result_id = $1', [krId]);
  if (allowed.length) {
    await db.query(
      `INSERT INTO goal_key_result_todos (key_result_id, todo_id) SELECT $1, UNNEST($2::int[]) ON CONFLICT DO NOTHING`,
      [krId, allowed]
    );
  }
}

/** Validates a key-result body; returns { value } or { error }. */
function cleanKeyResult(body) {
  const title = sanitizeText(body.title, 160);
  if (!title) return { error: 'Give each key result a title' };
  const kind = body.kind === 'todos' ? 'todos' : 'number';
  const start = num(body.start_value, 0);
  const target = num(body.target_value, 100);
  if (kind === 'number' && target === start) return { error: 'The target must be different from the starting value' };
  return {
    value: {
      title,
      kind,
      unit: sanitizeText(body.unit, 20),
      start,
      target,
      current: body.current_value === undefined ? start : num(body.current_value, start),
    },
  };
}

// GET /api/goals?status=active|all
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor) return res.status(401).json({ error: 'User no longer exists' });
    const goals = await loadGoals(actor);
    res.json({
      goals,
      can_company: isLeader(actor),
      manageable_businesses: [...actor.memberships.keys()].filter((id) => isLeader(actor) || managesBusiness(actor, id)),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/goals — { title, description?, scope, business_id?, starts_on, ends_on, key_results: [...] }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const title = sanitizeText(req.body.title, 160);
    if (!title) return res.status(400).json({ error: 'Give the goal a title' });
    const where = resolveScope(actor, req.body);
    if (where.error) return res.status(where.status).json({ error: where.error });
    const starts = YMD.test(String(req.body.starts_on || '')) ? req.body.starts_on : todayInAppZone();
    const ends = YMD.test(String(req.body.ends_on || '')) ? req.body.ends_on : null;
    if (!ends || ends < starts) return res.status(400).json({ error: 'Choose an end date that is after the start' });
    const list = Array.isArray(req.body.key_results) ? req.body.key_results.slice(0, MAX_KRS) : [];
    const cleaned = [];
    for (const item of list) {
      const out = cleanKeyResult(item);
      if (out.error) return res.status(400).json({ error: out.error });
      cleaned.push({ ...out.value, todo_ids: item.todo_ids });
    }

    const goal = (await db.query(
      `INSERT INTO goals (title, description, scope, business_id, owner_id, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [title, sanitizeText(req.body.description, 1000), where.scope, where.businessId, actor.id, starts, ends]
    )).rows[0];
    for (const [i, kr] of cleaned.entries()) {
      const row = (await db.query(
        `INSERT INTO goal_key_results (goal_id, title, kind, unit, start_value, target_value, current_value, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [goal.id, kr.title, kr.kind, kr.unit, kr.start, kr.target, kr.current, i]
      )).rows[0];
      if (kr.kind === 'todos') await setLinks(actor, row.id, kr.todo_ids);
    }

    // A company or business goal is news for the people it concerns.
    if (where.scope !== 'personal') {
      const audience = where.scope === 'company'
        ? (await db.query("SELECT id FROM users WHERE status != 'inactive'")).rows.map((r) => r.id)
        : (await db.query('SELECT user_id AS id FROM user_businesses WHERE business_id = $1', [where.businessId])).rows.map((r) => r.id);
      await notify(audience, {
        type: 'goal_new',
        title: where.scope === 'company' ? 'New company goal' : 'New goal for your business',
        body: title,
        data: { goalId: goal.id },
      }, { exclude: [actor.id] });
    }
    res.status(201).json({ goal: await loadGoal(actor, goal.id) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/goals/:id — { title?, description?, ends_on?, status? }
router.put('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const existing = await loadGoal(actor, parseInt(req.params.id, 10));
    if (!existing) return res.status(404).json({ error: 'Goal not found' });
    if (!existing.can_manage) return res.status(403).json({ error: 'Only its owner or a manager can change this goal' });
    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 160) : existing.title;
    if (!title) return res.status(400).json({ error: 'Give the goal a title' });
    const ends = req.body.ends_on !== undefined && YMD.test(String(req.body.ends_on)) ? req.body.ends_on : existing.ends_on;
    if (ends < existing.starts_on) return res.status(400).json({ error: 'The end date must be after the start' });
    const status = ['active', 'achieved', 'dropped'].includes(req.body.status) ? req.body.status : existing.status;
    await db.query(
      `UPDATE goals SET title = $2, description = $3, ends_on = $4, status = $5, updated_at = NOW() WHERE id = $1`,
      [existing.id, title, req.body.description !== undefined ? sanitizeText(req.body.description, 1000) : existing.description, ends, status]
    );
    res.json({ goal: await loadGoal(actor, existing.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/goals/:id
router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const existing = await loadGoal(actor, parseInt(req.params.id, 10));
    if (!existing) return res.status(404).json({ error: 'Goal not found' });
    if (!existing.can_manage) return res.status(403).json({ error: 'Only its owner or a manager can delete this goal' });
    await db.query('DELETE FROM goals WHERE id = $1', [existing.id]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/goals/:id/key-results — add one
router.post('/:id(\\d+)/key-results', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const goal = await loadGoal(actor, parseInt(req.params.id, 10));
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (!goal.can_manage) return res.status(403).json({ error: 'Only its owner or a manager can change this goal' });
    if (goal.key_results.length >= MAX_KRS) return res.status(400).json({ error: `A goal can have at most ${MAX_KRS} key results` });
    const out = cleanKeyResult(req.body);
    if (out.error) return res.status(400).json({ error: out.error });
    const kr = out.value;
    const row = (await db.query(
      `INSERT INTO goal_key_results (goal_id, title, kind, unit, start_value, target_value, current_value, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [goal.id, kr.title, kr.kind, kr.unit, kr.start, kr.target, kr.current, goal.key_results.length]
    )).rows[0];
    if (kr.kind === 'todos') await setLinks(actor, row.id, req.body.todo_ids);
    res.status(201).json({ goal: await loadGoal(actor, goal.id) });
  } catch (err) {
    next(err);
  }
});

/** The key result with its goal, if the actor may see the goal. */
async function loadKeyResult(actor, krId) {
  const kr = (await db.query('SELECT * FROM goal_key_results WHERE id = $1', [krId])).rows[0];
  if (!kr) return null;
  const goal = await loadGoal(actor, kr.goal_id);
  return goal ? { kr, goal } : null;
}

// PUT /api/goals/key-results/:krId — { title?, current_value?, target_value?, unit?, todo_ids? }
router.put('/key-results/:krId(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadKeyResult(actor, parseInt(req.params.krId, 10));
    if (!found) return res.status(404).json({ error: 'Key result not found' });
    if (!found.goal.can_manage) return res.status(403).json({ error: 'Only the goal owner or a manager can change this' });
    const { kr } = found;
    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 160) : kr.title;
    if (!title) return res.status(400).json({ error: 'Give the key result a title' });
    const target = req.body.target_value !== undefined ? num(req.body.target_value, Number(kr.target_value)) : Number(kr.target_value);
    const current = req.body.current_value !== undefined ? num(req.body.current_value, Number(kr.current_value)) : Number(kr.current_value);
    if (kr.kind === 'number' && target === Number(kr.start_value)) return res.status(400).json({ error: 'The target must be different from the starting value' });
    await db.query(
      `UPDATE goal_key_results SET title = $2, unit = $3, target_value = $4, current_value = $5, updated_at = NOW() WHERE id = $1`,
      [kr.id, title, req.body.unit !== undefined ? sanitizeText(req.body.unit, 20) : kr.unit, target, current]
    );
    if (kr.kind === 'todos' && Array.isArray(req.body.todo_ids)) await setLinks(actor, kr.id, req.body.todo_ids);
    res.json({ goal: await loadGoal(actor, kr.goal_id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/goals/key-results/:krId
router.delete('/key-results/:krId(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadKeyResult(actor, parseInt(req.params.krId, 10));
    if (!found) return res.status(404).json({ error: 'Key result not found' });
    if (!found.goal.can_manage) return res.status(403).json({ error: 'Only the goal owner or a manager can change this' });
    await db.query('DELETE FROM goal_key_results WHERE id = $1', [found.kr.id]);
    res.json({ goal: await loadGoal(actor, found.goal.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/goals/key-results/:krId/todos — the to-dos a key result is measured by
router.get('/key-results/:krId(\\d+)/todos', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadKeyResult(actor, parseInt(req.params.krId, 10));
    if (!found) return res.status(404).json({ error: 'Key result not found' });
    const rows = (await db.query(
      `SELECT t.id, t.title, t.is_done, t.due_date, t.status
       FROM goal_key_result_todos r JOIN todos t ON t.id = r.todo_id
       WHERE r.key_result_id = $1 ORDER BY t.is_done, t.due_date NULLS LAST, t.id`,
      [found.kr.id]
    )).rows;
    // Titles of to-dos the viewer cannot open are withheld.
    const todos = [];
    for (const row of rows) {
      const visible = await getTodoFor(row.id, actor.id, actor);
      todos.push(visible ? row : { id: row.id, title: 'Private to-do', is_done: row.is_done, due_date: null, status: row.status, hidden: true });
    }
    res.json({ todos });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
