const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { todayInAppZone } = require('../utils/recurrence');
const { getTodoFor, descendantIds } = require('../services/todoQueries');
const { accessFor } = require('../services/bizAccess');
const { isYmd, addDaysYmd } = require('../utils/sprints');

const router = express.Router();

const MAX_MINUTES = 1440;
const BACK_DAYS = 31; // how far back a log may be dated
const SHEET_LIMIT = 500;

async function actorOf(req, res) {
  const actor = await loadActor(req.user.id);
  if (!actor) {
    res.status(401).json({ error: 'User no longer exists' });
    return null;
  }
  return actor;
}

/** A business task the actor can see, or a 404 / 400 already sent. */
async function visibleTask(actor, todoId, res) {
  const todo = todoId ? await getTodoFor(todoId, actor.id, actor) : null;
  if (!todo) {
    res.status(404).json({ error: 'Task not found' });
    return null;
  }
  if (!todo.business_id) {
    res.status(400).json({ error: 'Time is tracked on business tasks' });
    return null;
  }
  return todo;
}

function cleanMinutes(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES ? n : null;
}

/** A log date within the allowed window (today, or up to a month back); falls back to today. */
function cleanDate(raw, today) {
  if (!isYmd(raw)) return today;
  if (raw > today || raw < addDaysYmd(today, -BACK_DAYS)) return null;
  return raw;
}

const LOG_COLUMNS = `l.id, l.todo_id, t.title AS todo_title, t.business_id, b.name AS business_name,
                     l.user_id, u.name AS user_name, l.log_date, l.minutes, l.note, l.billable, l.status, l.created_at`;
const LOG_JOINS = `FROM time_logs l
                   JOIN todos t ON t.id = l.todo_id
                   JOIN businesses b ON b.id = t.business_id
                   JOIN users u ON u.id = l.user_id`;

async function runningTimer(userId) {
  return (await db.query(
    `SELECT tt.todo_id, t.title, t.business_id, tt.started_at
     FROM time_timers tt JOIN todos t ON t.id = tt.todo_id WHERE tt.user_id = $1`,
    [userId]
  )).rows[0] || null;
}

/** Stops the person's timer, if any, and logs what it measured. Returns the new log id or null. */
async function stopTimer(userId, note = '') {
  const timer = (await db.query('DELETE FROM time_timers WHERE user_id = $1 RETURNING todo_id, started_at', [userId])).rows[0];
  if (!timer) return null;
  const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.round((Date.now() - new Date(timer.started_at).getTime()) / 60000)));
  const row = (await db.query(
    `INSERT INTO time_logs (todo_id, user_id, log_date, minutes, note) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [timer.todo_id, userId, todayInAppZone(), minutes, sanitizeText(note, 300)]
  )).rows[0];
  return row.id;
}

// GET /api/time/mine?from=&to= — my own logs (default: the last 14 days) and my running timer
router.get('/mine', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const today = todayInAppZone();
    const to = isYmd(req.query.to) ? req.query.to : today;
    const from = isYmd(req.query.from) ? req.query.from : addDaysYmd(to, -13);
    const logs = (await db.query(
      `SELECT ${LOG_COLUMNS} ${LOG_JOINS}
       WHERE l.user_id = $1 AND l.log_date BETWEEN $2::date AND $3::date
       ORDER BY l.log_date DESC, l.id DESC LIMIT $4`,
      [actor.id, from, to, SHEET_LIMIT]
    )).rows;
    res.json({ logs, timer: await runningTimer(actor.id), today });
  } catch (err) {
    next(err);
  }
});

// POST /api/time/log — { todo_id, minutes, log_date?, note?, billable? }
router.post('/log', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visibleTask(actor, parseInt(req.body.todo_id, 10), res);
    if (!todo) return;
    const minutes = cleanMinutes(req.body.minutes);
    if (!minutes) return res.status(400).json({ error: 'Enter the time as minutes, from 1 to 1440' });
    const date = cleanDate(req.body.log_date, todayInAppZone());
    if (!date) return res.status(400).json({ error: `Log time for today or up to ${BACK_DAYS} days back` });
    const row = (await db.query(
      `INSERT INTO time_logs (todo_id, user_id, log_date, minutes, note, billable)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [todo.id, actor.id, date, minutes, sanitizeText(req.body.note, 300), req.body.billable !== false]
    )).rows[0];
    res.status(201).json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

// PUT /api/time/:id — { minutes?, note?, billable?, log_date? } while the log is still waiting for review
router.put('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const log = (await db.query('SELECT * FROM time_logs WHERE id = $1', [parseInt(req.params.id, 10)])).rows[0];
    if (!log || log.user_id !== actor.id) return res.status(404).json({ error: 'Time log not found' });
    if (log.status !== 'pending') return res.status(400).json({ error: 'A reviewed log cannot be changed' });
    const minutes = req.body.minutes === undefined ? log.minutes : cleanMinutes(req.body.minutes);
    if (!minutes) return res.status(400).json({ error: 'Enter the time as minutes, from 1 to 1440' });
    const date = req.body.log_date === undefined ? log.log_date : cleanDate(req.body.log_date, todayInAppZone());
    if (!date) return res.status(400).json({ error: `Log time for today or up to ${BACK_DAYS} days back` });
    await db.query(
      'UPDATE time_logs SET minutes = $2, note = $3, billable = $4, log_date = $5 WHERE id = $1',
      [log.id, minutes, req.body.note !== undefined ? sanitizeText(req.body.note, 300) : log.note, req.body.billable === undefined ? log.billable : req.body.billable !== false, date]
    );
    res.json({ updated: log.id });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/time/:id — my own log, while it is still waiting for review
router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const log = (await db.query('SELECT * FROM time_logs WHERE id = $1', [parseInt(req.params.id, 10)])).rows[0];
    if (!log || log.user_id !== actor.id) return res.status(404).json({ error: 'Time log not found' });
    if (log.status !== 'pending') return res.status(400).json({ error: 'A reviewed log cannot be removed' });
    await db.query('DELETE FROM time_logs WHERE id = $1', [log.id]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/time/timer/start — { todo_id }; a timer already running is stopped and logged first
router.post('/timer/start', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visibleTask(actor, parseInt(req.body.todo_id, 10), res);
    if (!todo) return;
    if (todo.is_done) return res.status(400).json({ error: 'This task is already finished' });
    await stopTimer(actor.id);
    await db.query('INSERT INTO time_timers (user_id, todo_id) VALUES ($1, $2)', [actor.id, todo.id]);
    res.status(201).json({ timer: await runningTimer(actor.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/time/timer/stop — { note? } logs the time the timer measured
router.post('/timer/stop', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const id = await stopTimer(actor.id, req.body?.note);
    if (!id) return res.status(400).json({ error: 'No timer is running' });
    res.json({ logged: id, timer: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/time/todo/:id — the time logged on a task, with everything below it added up
router.get('/todo/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visibleTask(actor, parseInt(req.params.id, 10), res);
    if (!todo) return;
    const below = await descendantIds(todo.id);
    const logs = (await db.query(
      `SELECT ${LOG_COLUMNS} ${LOG_JOINS} WHERE l.todo_id = $1 ORDER BY l.log_date DESC, l.id DESC LIMIT 100`,
      [todo.id]
    )).rows;
    const totals = (await db.query(
      `SELECT COALESCE(SUM(minutes) FILTER (WHERE todo_id = $1 AND status <> 'rejected'), 0)::int AS own,
              COALESCE(SUM(minutes) FILTER (WHERE status <> 'rejected'), 0)::int AS rolled_up
       FROM time_logs WHERE todo_id = ANY($2::int[])`,
      [todo.id, [todo.id, ...below]]
    )).rows[0];
    res.json({ logs, own_minutes: totals.own, total_minutes: totals.rolled_up, estimate_minutes: todo.duration_minutes || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/time/sheet?business_id=&from=&to= — the business timesheet (managers see everyone, others only themselves)
router.get('/sheet', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const businessId = parseInt(req.query.business_id, 10);
    const access = businessId ? accessFor(actor, businessId) : null;
    if (!access || !access.view) return res.status(404).json({ error: 'Business not found' });
    const today = todayInAppZone();
    const to = isYmd(req.query.to) ? req.query.to : today;
    const from = isYmd(req.query.from) ? req.query.from : addDaysYmd(to, -6);
    const logs = (await db.query(
      `SELECT ${LOG_COLUMNS} ${LOG_JOINS}
       WHERE t.business_id = $1 AND l.log_date BETWEEN $2::date AND $3::date AND ($4::boolean OR l.user_id = $5)
       ORDER BY l.log_date DESC, l.id DESC LIMIT $6`,
      [businessId, from, to, access.manage, actor.id, SHEET_LIMIT]
    )).rows;
    // What waits on this person: a reviewer is told about other people's logs, never their own.
    const pending = logs.filter((l) => l.status === 'pending' && (!access.manage || l.user_id !== actor.id)).length;
    res.json({ logs, from, to, can_review: access.manage, pending });
  } catch (err) {
    next(err);
  }
});

// POST /api/time/:id/review — { decision: 'approved' | 'rejected' }; a manager of the business, never on their own time
router.post('/:id(\\d+)/review', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const row = (await db.query(
      `SELECT l.id, l.todo_id, l.user_id, l.status, l.minutes, t.business_id, t.title
       FROM time_logs l JOIN todos t ON t.id = l.todo_id WHERE l.id = $1`,
      [parseInt(req.params.id, 10)]
    )).rows[0];
    if (!row || !row.business_id) return res.status(404).json({ error: 'Time log not found' });
    const access = accessFor(actor, row.business_id);
    if (!access.view) return res.status(404).json({ error: 'Time log not found' });
    if (!access.manage) return res.status(403).json({ error: 'Only a manager of this business can review time' });
    if (row.user_id === actor.id) return res.status(403).json({ error: 'Someone else needs to review your time' });
    const decision = req.body.decision;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Approve or reject' });
    await db.query(`UPDATE time_logs SET status = $2, reviewed_by = $3, reviewed_at = NOW() WHERE id = $1`, [row.id, decision, actor.id]);
    await notify([row.user_id], {
      type: 'time_reviewed',
      title: decision === 'approved' ? 'Your time was approved' : 'Your time was rejected',
      body: `${row.minutes} min on ${row.title}`,
      data: { todoId: row.todo_id, businessId: row.business_id },
    });
    res.json({ id: row.id, status: decision });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
