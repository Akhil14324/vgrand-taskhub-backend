const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify } = require('../utils/notify');
const { loadActor, isLeader, managesBusiness } = require('../utils/org');
const { todayInAppZone } = require('../utils/recurrence');
const { cleanPoints, isYmd, addDaysYmd, summarize, burndown, averageVelocity } = require('../utils/sprints');

const router = express.Router();

const DEFAULT_LENGTH_DAYS = 13; // a two-week sprint
const MAX_BATCH = 100;
const BACKLOG_LIMIT = 200;

/** What the actor may do with a business's sprints: anyone in the business (or leadership) sees them, managers plan them. */
function accessFor(actor, businessId) {
  return {
    view: isLeader(actor) || actor.memberships.has(businessId),
    manage: isLeader(actor) || managesBusiness(actor, businessId),
  };
}

/** Sprint row with its business, if the actor may see that business. */
async function loadSprintRow(actor, sprintId) {
  const row = (await db.query('SELECT * FROM sprints WHERE id = $1', [sprintId])).rows[0];
  if (!row) return null;
  const access = accessFor(actor, row.business_id);
  return access.view ? { sprint: row, access } : null;
}

/** Business task rows (not personal to-dos) that are in this business. */
async function businessTasks(businessId, ids) {
  return (await db.query(
    `SELECT id, business_id, sprint_id, is_done, review_state FROM todos WHERE business_id = $1 AND id = ANY($2::int[])`,
    [businessId, ids]
  )).rows;
}

/** Sprint summary numbers for a list of sprints (one query). */
async function sprintStats(businessId) {
  return (await db.query(
    `SELECT s.id, s.name, s.goal, s.starts_on, s.ends_on, s.status, s.started_at, s.completed_at,
            COUNT(t.id)::int AS task_count,
            COUNT(t.id) FILTER (WHERE t.is_done)::int AS done_count,
            COALESCE(SUM(t.story_points), 0)::int AS total_points,
            COALESCE(SUM(t.story_points) FILTER (WHERE t.is_done), 0)::int AS done_points
     FROM sprints s
     LEFT JOIN todos t ON t.sprint_id = s.id
     WHERE s.business_id = $1
     GROUP BY s.id
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, s.starts_on DESC, s.id DESC`,
    [businessId]
  )).rows;
}

/** Velocity: average points finished across recent completed sprints (oldest first). */
function velocityOf(rows) {
  const completed = rows
    .filter((r) => r.status === 'completed')
    .sort((a, b) => (a.completed_at > b.completed_at ? 1 : -1));
  return {
    average: averageVelocity(completed.map((r) => r.done_points)),
    completed: completed.map((r) => ({ id: r.id, name: r.name, points: r.done_points, ends_on: r.ends_on })),
  };
}

/** Full sprint: its tasks, the business backlog, and the burndown for a started sprint. */
async function loadSprintDetail(actor, sprintId) {
  const found = await loadSprintRow(actor, sprintId);
  if (!found) return null;
  const { sprint, access } = found;
  const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';

  const tasks = (await db.query(
    `SELECT t.id, t.title, t.status, t.is_done, t.story_points, t.priority, t.due_date, t.assignee_id,
            u.name AS assignee_name,
            CASE WHEN t.done_at IS NULL THEN NULL ELSE to_char(t.done_at AT TIME ZONE $2, 'YYYY-MM-DD') END AS done_on
     FROM todos t
     LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.sprint_id = $1
     ORDER BY t.is_done, t.priority, t.id`,
    [sprint.id, tz]
  )).rows;

  const backlog = sprint.status === 'completed' ? [] : (await db.query(
    `SELECT t.id, t.title, t.status, t.story_points, t.priority, t.due_date, u.name AS assignee_name
     FROM todos t
     LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.business_id = $1 AND t.sprint_id IS NULL AND NOT t.is_done AND t.review_state = 'accepted'
     ORDER BY t.priority, t.due_date NULLS LAST, t.id
     LIMIT $2`,
    [sprint.business_id, BACKLOG_LIMIT]
  )).rows;

  const today = todayInAppZone();
  const burn = sprint.status === 'planned' ? null : burndown({
    startsOn: sprint.starts_on,
    endsOn: sprint.ends_on,
    today: today < sprint.starts_on ? sprint.starts_on : today,
    // A task finished before the sprint was started is counted from its first day.
    items: tasks.map((t) => ({
      points: t.story_points || 0,
      doneOn: t.is_done ? (t.done_on && t.done_on > sprint.starts_on ? t.done_on : sprint.starts_on) : null,
    })),
  });

  const all = await sprintStats(sprint.business_id);
  const row = all.find((r) => r.id === sprint.id) || {};
  return {
    sprint: {
      id: sprint.id,
      business_id: sprint.business_id,
      name: sprint.name,
      goal: sprint.goal,
      starts_on: sprint.starts_on,
      ends_on: sprint.ends_on,
      status: sprint.status,
      started_at: sprint.started_at,
      completed_at: sprint.completed_at,
      task_count: row.task_count || 0,
      done_count: row.done_count || 0,
      total_points: row.total_points || 0,
      done_points: row.done_points || 0,
    },
    can_manage: access.manage,
    tasks: tasks.map(({ done_on: _ignored, ...t }) => t),
    backlog,
    burndown: burn,
    summary: summarize(tasks.map((t) => ({ points: t.story_points || 0, is_done: t.is_done }))),
    today,
  };
}

// GET /api/sprints?business_id= — the businesses the viewer can see, and one business's sprints
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor) return res.status(401).json({ error: 'User no longer exists' });
    const businesses = (await db.query('SELECT id, name FROM businesses ORDER BY name')).rows
      .map((b) => ({ id: b.id, name: b.name, ...accessFor(actor, b.id) }))
      .filter((b) => b.view);

    const requested = parseInt(req.query.business_id, 10);
    const chosen = businesses.find((b) => b.id === requested) || businesses[0] || null;
    if (!chosen) return res.json({ businesses: [], business: null, sprints: [], velocity: { average: null, completed: [] } });

    const rows = await sprintStats(chosen.id);
    res.json({
      businesses: businesses.map(({ id, name, manage }) => ({ id, name, can_manage: manage })),
      business: { id: chosen.id, name: chosen.name, can_manage: chosen.manage },
      sprints: rows.map((r) => ({
        id: r.id,
        name: r.name,
        goal: r.goal,
        starts_on: r.starts_on,
        ends_on: r.ends_on,
        status: r.status,
        started_at: r.started_at,
        completed_at: r.completed_at,
        task_count: r.task_count,
        done_count: r.done_count,
        total_points: r.total_points,
        done_points: r.done_points,
      })),
      velocity: velocityOf(rows),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/sprints — { business_id, name, goal?, starts_on?, ends_on? }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const businessId = parseInt(req.body.business_id, 10);
    if (!businessId) return res.status(400).json({ error: 'Choose a business' });
    if (!accessFor(actor, businessId).manage) return res.status(403).json({ error: 'Only a manager of this business can plan sprints' });
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Give the sprint a name' });
    const starts = isYmd(req.body.starts_on) ? req.body.starts_on : todayInAppZone();
    const ends = isYmd(req.body.ends_on) ? req.body.ends_on : addDaysYmd(starts, DEFAULT_LENGTH_DAYS);
    if (ends < starts) return res.status(400).json({ error: 'The end date must be after the start' });

    const row = (await db.query(
      `INSERT INTO sprints (business_id, name, goal, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [businessId, name, sanitizeText(req.body.goal, 300), starts, ends, actor.id]
    )).rows[0];
    res.status(201).json(await loadSprintDetail(actor, row.id));
  } catch (err) {
    next(err);
  }
});

// GET /api/sprints/:id — the sprint with its tasks, backlog and burndown
router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const detail = await loadSprintDetail(actor, parseInt(req.params.id, 10));
    if (!detail) return res.status(404).json({ error: 'Sprint not found' });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// PUT /api/sprints/:id — { name?, goal?, starts_on?, ends_on? }
router.put('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadSprintRow(actor, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Sprint not found' });
    if (!found.access.manage) return res.status(403).json({ error: 'Only a manager of this business can change a sprint' });
    const { sprint } = found;
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : sprint.name;
    if (!name) return res.status(400).json({ error: 'Give the sprint a name' });
    const starts = isYmd(req.body.starts_on) ? req.body.starts_on : sprint.starts_on;
    const ends = isYmd(req.body.ends_on) ? req.body.ends_on : sprint.ends_on;
    if (ends < starts) return res.status(400).json({ error: 'The end date must be after the start' });
    await db.query(
      `UPDATE sprints SET name = $2, goal = $3, starts_on = $4, ends_on = $5 WHERE id = $1`,
      [sprint.id, name, req.body.goal !== undefined ? sanitizeText(req.body.goal, 300) : sprint.goal, starts, ends]
    );
    res.json(await loadSprintDetail(actor, sprint.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/sprints/:id/start — planned → active (one active sprint per business)
router.post('/:id(\\d+)/start', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadSprintRow(actor, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Sprint not found' });
    if (!found.access.manage) return res.status(403).json({ error: 'Only a manager of this business can start a sprint' });
    const { sprint } = found;
    if (sprint.status !== 'planned') return res.status(400).json({ error: 'Only a planned sprint can be started' });
    const other = (await db.query(`SELECT name FROM sprints WHERE business_id = $1 AND status = 'active' AND id <> $2`, [sprint.business_id, sprint.id])).rows[0];
    if (other) return res.status(400).json({ error: `Complete "${other.name}" first. A business runs one sprint at a time.` });

    await db.query(`UPDATE sprints SET status = 'active', started_at = NOW() WHERE id = $1`, [sprint.id]);
    const members = (await db.query('SELECT user_id AS id FROM user_businesses WHERE business_id = $1', [sprint.business_id])).rows.map((r) => r.id);
    await notify(members, {
      type: 'sprint_started',
      title: 'Sprint started',
      body: sprint.name,
      data: { sprintId: sprint.id, businessId: sprint.business_id },
    }, { exclude: [actor.id] });
    res.json(await loadSprintDetail(actor, sprint.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/sprints/:id/complete — active → completed; unfinished tasks go back to the backlog
router.post('/:id(\\d+)/complete', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadSprintRow(actor, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Sprint not found' });
    if (!found.access.manage) return res.status(403).json({ error: 'Only a manager of this business can complete a sprint' });
    const { sprint } = found;
    if (sprint.status !== 'active') return res.status(400).json({ error: 'Only the active sprint can be completed' });

    await db.query(`UPDATE todos SET sprint_id = NULL WHERE sprint_id = $1 AND NOT is_done`, [sprint.id]);
    await db.query(`UPDATE sprints SET status = 'completed', completed_at = NOW() WHERE id = $1`, [sprint.id]);
    const members = (await db.query('SELECT user_id AS id FROM user_businesses WHERE business_id = $1', [sprint.business_id])).rows.map((r) => r.id);
    await notify(members, {
      type: 'sprint_completed',
      title: 'Sprint completed',
      body: sprint.name,
      data: { sprintId: sprint.id, businessId: sprint.business_id },
    }, { exclude: [actor.id] });
    res.json(await loadSprintDetail(actor, sprint.id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sprints/:id — not while it is active; its tasks return to the backlog
router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadSprintRow(actor, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Sprint not found' });
    if (!found.access.manage) return res.status(403).json({ error: 'Only a manager of this business can delete a sprint' });
    if (found.sprint.status === 'active') return res.status(400).json({ error: 'Complete the sprint before deleting it' });
    await db.query('DELETE FROM sprints WHERE id = $1', [found.sprint.id]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/sprints/:id/tasks — { todo_ids: [...] } adds open business tasks to the sprint
router.post('/:id(\\d+)/tasks', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadSprintRow(actor, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Sprint not found' });
    if (!found.access.manage) return res.status(403).json({ error: 'Only a manager of this business can plan a sprint' });
    const { sprint } = found;
    if (sprint.status === 'completed') return res.status(400).json({ error: 'A completed sprint cannot take new tasks' });
    const ids = [...new Set((Array.isArray(req.body.todo_ids) ? req.body.todo_ids : []).map((n) => parseInt(n, 10)).filter(Boolean))].slice(0, MAX_BATCH);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one task' });

    const rows = await businessTasks(sprint.business_id, ids);
    const addable = rows.filter((t) => !t.is_done && t.review_state === 'accepted').map((t) => t.id);
    if (addable.length) {
      await db.query('UPDATE todos SET sprint_id = $2 WHERE id = ANY($1::int[])', [addable, sprint.id]);
    }
    const skipped = ids.length - addable.length;
    res.json({ ...(await loadSprintDetail(actor, sprint.id)), added: addable.length, skipped });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sprints/:id/tasks/:todoId — take a task back to the backlog
router.delete('/:id(\\d+)/tasks/:todoId(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await loadSprintRow(actor, parseInt(req.params.id, 10));
    if (!found) return res.status(404).json({ error: 'Sprint not found' });
    if (!found.access.manage) return res.status(403).json({ error: 'Only a manager of this business can plan a sprint' });
    await db.query('UPDATE todos SET sprint_id = NULL WHERE id = $1 AND sprint_id = $2', [parseInt(req.params.todoId, 10), found.sprint.id]);
    res.json(await loadSprintDetail(actor, found.sprint.id));
  } catch (err) {
    next(err);
  }
});

// PUT /api/sprints/tasks/:todoId/points — { story_points: 0-100 or null }
router.put('/tasks/:todoId(\\d+)/points', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const todo = (await db.query('SELECT id, business_id, sprint_id FROM todos WHERE id = $1', [parseInt(req.params.todoId, 10)])).rows[0];
    if (!todo || !todo.business_id) return res.status(404).json({ error: 'Task not found' });
    if (!accessFor(actor, todo.business_id).manage) return res.status(403).json({ error: 'Only a manager of this business can estimate tasks' });
    const points = cleanPoints(req.body.story_points);
    if (points.error) return res.status(400).json({ error: points.error });
    await db.query('UPDATE todos SET story_points = $2 WHERE id = $1', [todo.id, points.value]);
    if (todo.sprint_id) return res.json(await loadSprintDetail(actor, todo.sprint_id));
    res.json({ todo: { id: todo.id, story_points: points.value } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
