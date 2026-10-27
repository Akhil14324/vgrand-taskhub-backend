const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');
const { audienceIds, getTodoFor } = require('../services/todoQueries');
const { assignTodo } = require('../services/todoTimeline');
const { isAssignable } = require('../services/todoGovernance');
const { accessFor } = require('../services/bizAccess');
const { sprintStats, velocityOf } = require('../services/sprintData');
const { cleanPoints, isYmd } = require('../utils/sprints');
const {
  ITEM_TYPES, STATUS_ORDER, cleanWip, cumulativeFlow, lastDays, lastWeeks, leadCycleByWeek,
} = require('../utils/workspace');

const router = express.Router();

const MAX_BULK = 100;
const STAGES = ['plan', 'build', 'test', 'released'];

/** The signed-in person, or a 401 already sent. */
async function actorOf(req, res) {
  const actor = await loadActor(req.user.id);
  if (!actor) {
    res.status(401).json({ error: 'User no longer exists' });
    return null;
  }
  return actor;
}

/** Business id from the query or body, checked against what the actor may see (or manage). Sends the error itself. */
function businessFor(actor, raw, res, { manage = false } = {}) {
  const businessId = parseInt(raw, 10);
  if (!businessId) {
    res.status(400).json({ error: 'Choose a business' });
    return null;
  }
  const access = accessFor(actor, businessId);
  if (!access.view) {
    res.status(404).json({ error: 'Business not found' });
    return null;
  }
  if (manage && !access.manage) {
    res.status(403).json({ error: 'Only a manager of this business can change this' });
    return null;
  }
  return { businessId, access };
}

async function isMember(businessId, userId) {
  return !!(await db.query('SELECT 1 FROM user_businesses WHERE business_id = $1 AND user_id = $2', [businessId, userId])).rows[0];
}

const EPIC_SQL = `
  SELECT e.id, e.name, e.description, e.status, e.due_on, e.owner_id, ou.name AS owner_name, e.created_at,
         COUNT(t.id)::int AS task_count,
         COUNT(t.id) FILTER (WHERE t.is_done)::int AS done_count,
         COALESCE(SUM(t.story_points), 0)::int AS total_points,
         COALESCE(SUM(t.story_points) FILTER (WHERE t.is_done), 0)::int AS done_points
  FROM epics e
  LEFT JOIN users ou ON ou.id = e.owner_id
  LEFT JOIN todos t ON t.epic_id = e.id
  WHERE e.business_id = $1
  GROUP BY e.id, ou.name
  ORDER BY (e.status = 'open') DESC, e.created_at DESC, e.id DESC`;

const RELEASE_SQL = `
  SELECT r.id, r.name, r.notes, r.stage, r.release_on, r.owner_id, ou.name AS owner_name, r.released_at, r.created_at,
         COUNT(t.id)::int AS task_count,
         COUNT(t.id) FILTER (WHERE t.is_done)::int AS done_count,
         COALESCE(SUM(t.story_points), 0)::int AS total_points,
         COALESCE(SUM(t.story_points) FILTER (WHERE t.is_done), 0)::int AS done_points
  FROM releases r
  LEFT JOIN users ou ON ou.id = r.owner_id
  LEFT JOIN todos t ON t.release_id = r.id
  WHERE r.business_id = $1
  GROUP BY r.id, ou.name
  ORDER BY CASE r.stage WHEN 'released' THEN 1 ELSE 0 END, r.release_on NULLS LAST, r.id DESC`;

/** Epics, releases and WIP limits of one business, with progress numbers. */
async function overview(businessId, access) {
  const [epics, releases, biz] = await Promise.all([
    db.query(EPIC_SQL, [businessId]),
    db.query(RELEASE_SQL, [businessId]),
    db.query('SELECT wip_limits FROM businesses WHERE id = $1', [businessId]),
  ]);
  return {
    business_id: businessId,
    can_manage: access.manage,
    epics: epics.rows,
    releases: releases.rows,
    wip_limits: biz.rows[0]?.wip_limits || {},
  };
}

// GET /api/workspace/overview?business_id=
router.get('/overview', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ctx = businessFor(actor, req.query.business_id, res);
    if (!ctx) return;
    res.json(await overview(ctx.businessId, ctx.access));
  } catch (err) {
    next(err);
  }
});

// ---- epics ------------------------------------------------------------------------------------------------------

// POST /api/workspace/epics — { business_id, name, description?, owner_id?, due_on? }
router.post('/epics', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ctx = businessFor(actor, req.body.business_id, res, { manage: true });
    if (!ctx) return;
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Give the epic a name' });
    const ownerId = parseInt(req.body.owner_id, 10) || null;
    if (ownerId && !(await isMember(ctx.businessId, ownerId))) return res.status(400).json({ error: 'The owner must be in this business' });
    await db.query(
      `INSERT INTO epics (business_id, name, description, owner_id, due_on, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.businessId, name, sanitizeText(req.body.description, 500), ownerId, isYmd(req.body.due_on) ? req.body.due_on : null, actor.id]
    );
    res.status(201).json(await overview(ctx.businessId, ctx.access));
  } catch (err) {
    next(err);
  }
});

async function loadEpic(actor, id, res) {
  const epic = (await db.query('SELECT * FROM epics WHERE id = $1', [id])).rows[0];
  if (!epic) {
    res.status(404).json({ error: 'Epic not found' });
    return null;
  }
  const ctx = businessFor(actor, epic.business_id, res, { manage: true });
  return ctx ? { epic, ctx } : null;
}

// PUT /api/workspace/epics/:id — { name?, description?, owner_id?, status?, due_on? }
router.put('/epics/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await loadEpic(actor, parseInt(req.params.id, 10), res);
    if (!found) return;
    const { epic, ctx } = found;
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : epic.name;
    if (!name) return res.status(400).json({ error: 'Give the epic a name' });
    let ownerId = epic.owner_id;
    if (req.body.owner_id !== undefined) {
      ownerId = parseInt(req.body.owner_id, 10) || null;
      if (ownerId && !(await isMember(ctx.businessId, ownerId))) return res.status(400).json({ error: 'The owner must be in this business' });
    }
    const status = ['open', 'done'].includes(req.body.status) ? req.body.status : epic.status;
    const dueOn = req.body.due_on === null ? null : (isYmd(req.body.due_on) ? req.body.due_on : epic.due_on);
    await db.query(
      `UPDATE epics SET name = $2, description = $3, owner_id = $4, status = $5, due_on = $6 WHERE id = $1`,
      [epic.id, name, req.body.description !== undefined ? sanitizeText(req.body.description, 500) : epic.description, ownerId, status, dueOn]
    );
    res.json(await overview(ctx.businessId, ctx.access));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspace/epics/:id — its tasks stay, without an epic
router.delete('/epics/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await loadEpic(actor, parseInt(req.params.id, 10), res);
    if (!found) return;
    await db.query('DELETE FROM epics WHERE id = $1', [found.epic.id]);
    res.json(await overview(found.ctx.businessId, found.ctx.access));
  } catch (err) {
    next(err);
  }
});

// ---- releases ---------------------------------------------------------------------------------------------------

// POST /api/workspace/releases — { business_id, name, notes?, release_on?, owner_id? }
router.post('/releases', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ctx = businessFor(actor, req.body.business_id, res, { manage: true });
    if (!ctx) return;
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Give the release a name' });
    const ownerId = parseInt(req.body.owner_id, 10) || null;
    if (ownerId && !(await isMember(ctx.businessId, ownerId))) return res.status(400).json({ error: 'The owner must be in this business' });
    await db.query(
      `INSERT INTO releases (business_id, name, notes, release_on, owner_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.businessId, name, sanitizeText(req.body.notes, 500), isYmd(req.body.release_on) ? req.body.release_on : null, ownerId, actor.id]
    );
    res.status(201).json(await overview(ctx.businessId, ctx.access));
  } catch (err) {
    next(err);
  }
});

async function loadRelease(actor, id, res) {
  const release = (await db.query('SELECT * FROM releases WHERE id = $1', [id])).rows[0];
  if (!release) {
    res.status(404).json({ error: 'Release not found' });
    return null;
  }
  const ctx = businessFor(actor, release.business_id, res, { manage: true });
  return ctx ? { release, ctx } : null;
}

// PUT /api/workspace/releases/:id — { name?, notes?, stage?, release_on?, owner_id? }
router.put('/releases/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await loadRelease(actor, parseInt(req.params.id, 10), res);
    if (!found) return;
    const { release, ctx } = found;
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : release.name;
    if (!name) return res.status(400).json({ error: 'Give the release a name' });
    let ownerId = release.owner_id;
    if (req.body.owner_id !== undefined) {
      ownerId = parseInt(req.body.owner_id, 10) || null;
      if (ownerId && !(await isMember(ctx.businessId, ownerId))) return res.status(400).json({ error: 'The owner must be in this business' });
    }
    const stage = STAGES.includes(req.body.stage) ? req.body.stage : release.stage;
    const releaseOn = req.body.release_on === null ? null : (isYmd(req.body.release_on) ? req.body.release_on : release.release_on);
    await db.query(
      `UPDATE releases SET name = $2, notes = $3, stage = $4, release_on = $5, owner_id = $6,
              released_at = CASE WHEN $4::varchar = 'released' THEN COALESCE(released_at, NOW()) ELSE NULL END
       WHERE id = $1`,
      [release.id, name, req.body.notes !== undefined ? sanitizeText(req.body.notes, 500) : release.notes, stage, releaseOn, ownerId]
    );
    if (stage === 'released' && release.stage !== 'released') {
      const members = (await db.query('SELECT user_id AS id FROM user_businesses WHERE business_id = $1', [ctx.businessId])).rows.map((r) => r.id);
      await notify(members, {
        type: 'release_done',
        title: 'Released',
        body: name,
        data: { businessId: ctx.businessId, releaseId: release.id },
      }, { exclude: [actor.id] });
    }
    res.json(await overview(ctx.businessId, ctx.access));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspace/releases/:id — its tasks stay, without a release
router.delete('/releases/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await loadRelease(actor, parseInt(req.params.id, 10), res);
    if (!found) return;
    await db.query('DELETE FROM releases WHERE id = $1', [found.release.id]);
    res.json(await overview(found.ctx.businessId, found.ctx.access));
  } catch (err) {
    next(err);
  }
});

// ---- limits -----------------------------------------------------------------------------------------------------

// PUT /api/workspace/wip — { business_id, limits: { in_progress: 5, ... } } (a missing status has no limit)
router.put('/wip', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ctx = businessFor(actor, req.body.business_id, res, { manage: true });
    if (!ctx) return;
    await db.query('UPDATE businesses SET wip_limits = $2::jsonb WHERE id = $1', [ctx.businessId, JSON.stringify(cleanWip(req.body.limits))]);
    res.json(await overview(ctx.businessId, ctx.access));
  } catch (err) {
    next(err);
  }
});

// ---- planning fields of a task -----------------------------------------------------------------------------------

/** Validates and applies { item_type, story_points, epic_id, release_id, sprint_id } to one business task. */
async function applyPlan(actor, todoId, patch) {
  const todo = (await db.query('SELECT id, business_id, is_done, parent_id FROM todos WHERE id = $1', [todoId])).rows[0];
  if (!todo || !todo.business_id) return { status: 404, error: 'Task not found' };
  if (!accessFor(actor, todo.business_id).manage) return { status: 403, error: 'Only a manager of this business can plan tasks' };

  const sets = [];
  const values = [todo.id];
  const add = (column, value) => sets.push(`${column} = $${values.push(value)}`);

  if ('item_type' in patch) {
    if (!ITEM_TYPES.includes(patch.item_type)) return { status: 400, error: 'Choose Task, Feature or Bug' };
    add('item_type', patch.item_type);
  }
  if ('story_points' in patch) {
    const points = cleanPoints(patch.story_points);
    if (points.error) return { status: 400, error: points.error };
    add('story_points', points.value);
  }
  if ('epic_id' in patch) {
    const id = patch.epic_id === null || patch.epic_id === '' ? null : parseInt(patch.epic_id, 10);
    if (id && !(await db.query('SELECT 1 FROM epics WHERE id = $1 AND business_id = $2', [id, todo.business_id])).rows[0]) {
      return { status: 400, error: 'That epic belongs to another business' };
    }
    add('epic_id', id || null);
  }
  if ('release_id' in patch) {
    const id = patch.release_id === null || patch.release_id === '' ? null : parseInt(patch.release_id, 10);
    if (id && !(await db.query('SELECT 1 FROM releases WHERE id = $1 AND business_id = $2', [id, todo.business_id])).rows[0]) {
      return { status: 400, error: 'That release belongs to another business' };
    }
    add('release_id', id || null);
  }
  if ('sprint_id' in patch) {
    const id = patch.sprint_id === null || patch.sprint_id === '' ? null : parseInt(patch.sprint_id, 10);
    if (id) {
      const sprint = (await db.query('SELECT status FROM sprints WHERE id = $1 AND business_id = $2', [id, todo.business_id])).rows[0];
      if (!sprint) return { status: 400, error: 'That sprint belongs to another business' };
      if (sprint.status === 'completed') return { status: 400, error: 'A finished sprint cannot take new tasks' };
      if (todo.is_done) return { status: 400, error: 'A finished task cannot join a sprint' };
    }
    add('sprint_id', id || null);
  }
  if (!sets.length) return { status: 400, error: 'Nothing to change' };

  await db.query(`UPDATE todos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, values);
  emitToUsers(await audienceIds(todo.id), 'todo:changed', { todoId: todo.id, action: 'updated' });
  return { todoId: todo.id };
}

// PUT /api/workspace/items/:id — { item_type?, story_points?, epic_id?, release_id?, sprint_id? }
router.put('/items/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const out = await applyPlan(actor, parseInt(req.params.id, 10), req.body || {});
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ updated: out.todoId });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspace/items/bulk — { ids: [...], patch: { ... } } plans many tasks at once
router.post('/items/bulk', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map((n) => parseInt(n, 10)).filter(Boolean))].slice(0, MAX_BULK);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one task' });
    const patch = req.body.patch && typeof req.body.patch === 'object' ? req.body.patch : {};
    let updated = 0;
    let firstError = null;
    for (const id of ids) {
      const out = await applyPlan(actor, id, patch);
      if (out.error) firstError = firstError || out.error;
      else updated += 1;
    }
    if (!updated && firstError) return res.status(400).json({ error: firstError });
    res.json({ updated, failed: ids.length - updated, error: firstError });
  } catch (err) {
    next(err);
  }
});

// ---- handing work over --------------------------------------------------------------------------------------------

// POST /api/workspace/reassign — { user_id, ids: [...] } or { user_id, business_id, from_user_id }
// Gives tasks to someone else, one task at a time through the same rules as the Assign button.
router.post('/reassign', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const userId = parseInt(req.body.user_id, 10);
    if (!userId) return res.status(400).json({ error: 'Choose who gets the work' });
    const target = (await db.query(`SELECT id FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0];
    if (!target) return res.status(404).json({ error: 'Person not found' });

    let ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((n) => parseInt(n, 10)).filter(Boolean);
    if (!ids.length && req.body.from_user_id) {
      const ctx = businessFor(actor, req.body.business_id, res, { manage: true });
      if (!ctx) return;
      ids = (await db.query(
        `SELECT id FROM todos
         WHERE business_id = $1 AND assignee_id = $2 AND NOT is_done AND parent_id IS NULL AND review_state = 'accepted'
         LIMIT $3`,
        [ctx.businessId, parseInt(req.body.from_user_id, 10), MAX_BULK]
      )).rows.map((r) => r.id);
    }
    ids = [...new Set(ids)].slice(0, MAX_BULK);
    if (!ids.length) return res.status(400).json({ error: 'There is nothing to hand over' });

    let updated = 0;
    let firstError = null;
    for (const id of ids) {
      const todo = await getTodoFor(id, actor.id, actor);
      if (!todo || !todo.business_id) { firstError = firstError || 'Task not found'; continue; }
      if (!todo.permissions.can_assign) { firstError = firstError || 'You cannot give some of these to someone else'; continue; }
      if (!(await isAssignable(userId, todo.business_id))) { firstError = firstError || 'That person is not part of this business'; continue; }
      if (await assignTodo({ id: todo.id, title: todo.title }, userId, actor)) updated += 1;
      emitToUsers(await audienceIds(todo.id), 'todo:changed', { todoId: todo.id, action: 'updated' });
    }
    if (!updated && firstError) return res.status(400).json({ error: firstError });
    res.json({ updated, failed: ids.length - updated, error: firstError });
  } catch (err) {
    next(err);
  }
});

// ---- reports ----------------------------------------------------------------------------------------------------

// GET /api/workspace/reports?business_id=&days=30
router.get('/reports', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ctx = businessFor(actor, req.query.business_id, res);
    if (!ctx) return;
    const { businessId } = ctx;
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const today = todayInAppZone();
    const tz = APP_TIMEZONE;
    const dayList = lastDays(today, days);
    const weeks = lastWeeks(today, 8);

    // Velocity: points finished in each completed sprint.
    const sprintRows = await sprintStats(businessId);
    const velocity = velocityOf(sprintRows);
    const active = sprintRows.find((s) => s.status === 'active') || null;

    // Cumulative flow: replay the status history of every top-level task that was open during the window.
    const todos = (await db.query(
      `SELECT id, status, is_done, to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS created_on
       FROM todos
       WHERE business_id = $1 AND parent_id IS NULL AND review_state = 'accepted'
         AND (NOT is_done OR done_at IS NULL OR (done_at AT TIME ZONE $2)::date >= $3::date)`,
      [businessId, tz, dayList[0]]
    )).rows;
    const ids = todos.map((t) => t.id);
    const events = ids.length ? (await db.query(
      `SELECT todo_id, kind, to_value, to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS on_day
       FROM todo_events
       WHERE todo_id = ANY($1::int[]) AND kind IN ('status', 'completed', 'reopened')
       ORDER BY created_at, id`,
      [ids, tz]
    )).rows : [];
    const byTodo = new Map(todos.map((t) => [t.id, []]));
    for (const e of events) {
      const status = e.kind === 'completed' ? 'done' : STATUS_ORDER.includes(e.to_value) ? e.to_value : (e.kind === 'reopened' ? 'todo' : null);
      if (status) byTodo.get(e.todo_id)?.push({ on: e.on_day, status });
    }
    const flow = cumulativeFlow({
      days: dayList,
      today,
      items: todos.map((t) => ({
        createdOn: t.created_on,
        transitions: byTodo.get(t.id) || [],
        current: t.is_done ? 'done' : (STATUS_ORDER.includes(t.status) ? t.status : 'todo'),
      })),
    });

    // Lead time (created to done) and cycle time (started to done), by week.
    const doneRows = (await db.query(
      `SELECT to_char(done_at AT TIME ZONE $2, 'YYYY-MM-DD') AS done_on,
              EXTRACT(EPOCH FROM (done_at - created_at))::bigint AS lead_s,
              EXTRACT(EPOCH FROM (done_at - COALESCE(started_at, created_at)))::bigint AS cycle_s
       FROM todos
       WHERE business_id = $1 AND parent_id IS NULL AND is_done AND done_at IS NOT NULL
         AND (done_at AT TIME ZONE $2)::date >= $3::date`,
      [businessId, tz, weeks[0]]
    )).rows.map((r) => ({ doneOn: r.done_on, leadS: Number(r.lead_s), cycleS: Number(r.cycle_s) }));
    const weekly = leadCycleByWeek(doneRows, weeks);
    const avg = (key) => (doneRows.length ? Math.round((doneRows.reduce((s, r) => s + r[key], 0) / doneRows.length / 3600) * 10) / 10 : null);

    const workload = (await db.query(
      `SELECT t.assignee_id AS user_id, COALESCE(u.name, 'Nobody yet') AS name,
              COUNT(*)::int AS open_tasks,
              COALESCE(SUM(t.story_points), 0)::int AS open_points,
              COUNT(*) FILTER (WHERE t.due_date < $2::date)::int AS overdue
       FROM todos t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.business_id = $1 AND t.parent_id IS NULL AND NOT t.is_done AND t.review_state = 'accepted'
       GROUP BY t.assignee_id, u.name
       ORDER BY open_points DESC, open_tasks DESC`,
      [businessId, today]
    )).rows;

    const types = (await db.query(
      `SELECT item_type, COUNT(*) FILTER (WHERE NOT is_done)::int AS open, COUNT(*) FILTER (WHERE is_done)::int AS done
       FROM todos WHERE business_id = $1 AND parent_id IS NULL AND review_state = 'accepted'
       GROUP BY item_type ORDER BY item_type`,
      [businessId]
    )).rows;

    const time = (await db.query(
      `SELECT l.user_id, u.name,
              COALESCE(SUM(l.minutes) FILTER (WHERE l.status = 'approved'), 0)::int AS approved,
              COALESCE(SUM(l.minutes) FILTER (WHERE l.status = 'pending'), 0)::int AS pending
       FROM time_logs l JOIN todos t ON t.id = l.todo_id JOIN users u ON u.id = l.user_id
       WHERE t.business_id = $1 AND l.log_date >= $2::date
       GROUP BY l.user_id, u.name
       ORDER BY approved DESC, pending DESC`,
      [businessId, dayList[0]]
    )).rows;

    res.json({
      days,
      velocity,
      active_sprint: active && { id: active.id, name: active.name, total_points: active.total_points, done_points: active.done_points },
      flow,
      lead_cycle: { weekly, lead_h: avg('leadS'), cycle_h: avg('cycleS'), done: doneRows.length },
      workload,
      types,
      time,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.applyPlan = applyPlan;
