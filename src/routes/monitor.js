const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { todayInAppZone } = require('../utils/recurrence');
const { TODO_SELECT, getTodoFor, memberIds } = require('../services/todoQueries');
const { buildTimeline } = require('../services/todoTimeline');
const {
  actorCanMonitor,
  monitorablePeople,
  parseDays,
  statsForPeople,
  teamTotals,
  weeklyCompletions,
} = require('../services/monitor');

const router = express.Router();

/** Only the Chairman, Chief of Staff, Directors and business heads get past this. */
async function requireMonitor(req, res, next) {
  try {
    const { actor, people } = await monitorablePeople(req.user.id);
    if (!actorCanMonitor(actor)) {
      return res.status(403).json({ error: 'Only leadership and business heads can monitor to-dos' });
    }
    req.monitor = { actor, people, ids: new Set(people.map((p) => p.id)) };
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/monitor/access
router.get('/access', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    res.json({ can_monitor: actorCanMonitor(actor) });
  } catch (err) {
    next(err);
  }
});

// GET /api/monitor/overview?days=7|30|90 — everyone I may watch, with numbers, plus team totals
router.get('/overview', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    const { people } = req.monitor;
    const stats = await statsForPeople(people.map((p) => p.id), days);
    res.json({
      days,
      today: todayInAppZone(),
      team: teamTotals(stats),
      people: people.map((p) => ({ ...p, stats: stats.get(p.id) })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/monitor/people/:id?days= — one person: numbers, open work, recent completions, activity
router.get('/people/:id', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const personId = parseInt(req.params.id, 10);
    const person = req.monitor.people.find((p) => p.id === personId);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    const days = parseDays(req.query.days);

    const [stats, week, todos, activity] = await Promise.all([
      statsForPeople([personId], days),
      weeklyCompletions(personId),
      db.query(
        `${TODO_SELECT}
         WHERE tm.user_id = $1 AND (t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '30 days')
         ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.priority ASC, t.created_at DESC
         LIMIT 400`,
        [personId]
      ),
      db.query(
        `SELECT e.id, e.todo_id, e.kind, e.user_id, u.name AS user_name, e.from_value, e.to_value, e.note, e.meta, e.created_at,
                COALESCE(t.title, e.meta->>'title') AS todo_title
         FROM todo_events e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN todos t ON t.id = e.todo_id
         WHERE e.subject_id = $1 AND e.kind NOT IN ('created', 'shared')
         ORDER BY e.created_at DESC LIMIT 60`,
        [personId]
      ),
    ]);

    res.json({
      person,
      days,
      stats: stats.get(personId),
      week,
      today: todayInAppZone(),
      todos: todos.rows,
      activity: activity.rows,
    });
  } catch (err) {
    next(err);
  }
});

/** The member of a to-do whose list the actor may view it through, or null. */
function viewerMember(req, members) {
  if (members.includes(req.user.id)) return req.user.id;
  return members.find((id) => req.monitor.ids.has(id)) || null;
}

// GET /api/monitor/todos/:id — a monitored person's to-do with its full timeline (read-only)
router.get('/todos/:id', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const todoId = parseInt(req.params.id, 10);
    const members = await memberIds(todoId);
    const through = viewerMember(req, members);
    if (!through) return res.status(404).json({ error: 'To-do not found' });
    const todo = await getTodoFor(todoId, through);
    res.json({ todo, ...(await buildTimeline(todo)) });
  } catch (err) {
    next(err);
  }
});

// POST /api/monitor/todos/:id/questions — { message } "Why is this taking so long?"
router.post('/todos/:id/questions', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const todoId = parseInt(req.params.id, 10);
    const members = await memberIds(todoId);
    const through = viewerMember(req, members);
    if (!through) return res.status(404).json({ error: 'To-do not found' });
    const message = sanitizeText(req.body.message, 1000);
    if (!message) return res.status(400).json({ error: 'Write your question' });

    const todo = await getTodoFor(todoId, through);
    const inserted = await db.query(
      `INSERT INTO todo_comments (todo_id, user_id, body, kind) VALUES ($1, $2, $3, 'question') RETURNING id`,
      [todoId, req.user.id, message]
    );
    const asker = (await db.query('SELECT name FROM users WHERE id = $1', [req.user.id])).rows[0];
    // The accountable person first; everyone else on the to-do hears about it too.
    await notify([todo.assignee_id, ...members].filter(Boolean), {
      type: 'todo_question',
      title: `❓ ${asker.name} has a question`,
      body: `${todo.title}: ${message.slice(0, 140)}`,
      data: { todoId },
    }, { exclude: [req.user.id] });
    emitToUsers(members, 'todo:changed', { todoId, action: 'commented' });
    res.status(201).json({ id: inserted.rows[0].id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
