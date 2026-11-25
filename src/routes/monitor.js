const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');
const { listTodos, getTodoFor, memberIds, descendantIds } = require('../services/todoQueries');
const { buildTimeline, logEvent } = require('../services/todoTimeline');
const { followDueChange } = require('../services/dependencies');
const { SYSTEM_COLUMNS, DEFAULT_STATUS_LABELS } = require('../utils/columns');
const { openProcesses } = require('../services/processes');
const {
  actorCanMonitor,
  monitorablePeople,
  parsePeriod,
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
    const period = parsePeriod(req.query);
    const { people } = req.monitor;
    const ids = people.map((p) => p.id);
    const [stats, processes] = await Promise.all([statsForPeople(ids, period), openProcesses({ userIds: ids })]);
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    res.json({
      ...period,
      today: todayInAppZone(),
      team: teamTotals(stats),
      people: people.map((p) => ({ ...p, stats: stats.get(p.id) })),
      // Tasks made of steps where nothing has been finished for a while and the date is close, worst first.
      stalled: processes
        .filter((p) => p.stalled)
        .sort((a, b) => (a.daysToDue ?? 99) - (b.daysToDue ?? 99) || b.idleDays - a.idleDays)
        .slice(0, 20)
        .map((p) => ({ id: p.id, title: p.title, assignee_id: p.assignee_id, assignee_name: nameOf.get(p.assignee_id) || '', done: p.done, total: p.total, pct: p.pct, idle_days: p.idleDays, days_to_due: p.daysToDue })),
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
    const period = parsePeriod(req.query);

    const [stats, week, todos, activity] = await Promise.all([
      statsForPeople([personId], period),
      weeklyCompletions(personId),
      // Everything on the person's own list: personal to-dos and the business tasks they are on.
      listTodos(personId, {
        listOnly: true,
        dumped: 'any',
        where: period.from
          ? `(t.is_done = FALSE OR (t.done_at AT TIME ZONE $5)::date BETWEEN $6::date AND $7::date)`
          : `(t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '30 days' OR t.due_date >= CURRENT_DATE - 30)`,
        params: period.from ? [APP_TIMEZONE, period.from, period.to] : [],
        tail: 'ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.priority ASC, t.created_at DESC LIMIT 400',
      }),
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
      ...period,
      stats: stats.get(personId),
      week,
      today: todayInAppZone(),
      todos,
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
    // Every step under it, at any depth, so the people above see the whole process and not only the top task.
    const stepIds = await descendantIds(todoId);
    const subtasks = stepIds.length
      ? await listTodos(through, { where: 't.id = ANY($5::int[])', params: [stepIds], watching: 'any', dumped: 'any', tail: 'ORDER BY t.created_at, t.id' })
      : [];
    res.json({ todo, subtasks, ...(await buildTimeline(todo)) });
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
      title: `${asker.name} has a question`,
      body: `${todo.title}: ${message.slice(0, 140)}`,
      data: { todoId },
    }, { exclude: [req.user.id] });
    emitToUsers(members, 'todo:changed', { todoId, action: 'commented' });
    res.status(201).json({ id: inserted.rows[0].id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// A person's whole board (read-only), and the few things a manager may change on it
// ---------------------------------------------------------------------------

const BOARD_COLUMNS = ['person', 'status', 'date', 'deadline', 'priority', 'labels', 'estimate', 'entered'];
// What the person sees of their own task stays theirs: for the manager every flag is off except commenting and adjusting.
const WATCHER_PERMISSIONS = {
  can_edit: false, can_delete: false, can_leave: false, can_request_delete: false, can_change_status: false,
  can_hold: false, can_assign: false, can_approve: false, can_review: false, can_warn: false, can_nudge: false,
  can_comment: true, can_add_subtask: false, can_adjust: true,
};

// GET /api/monitor/people/:id/board — everything on one person's list as a read-only board (the table, filters, kanban,
// calendar and gantt of the app draw it like any other board). Groups are the person's businesses; personal work has none.
router.get('/people/:id(\\d+)/board', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const personId = parseInt(req.params.id, 10);
    const person = req.monitor.people.find((p) => p.id === personId);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const rows = await listTodos(personId, {
      listOnly: true,
      dumped: 'any',
      where: `(t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '60 days')`,
      tail: 'ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.priority ASC, t.created_at DESC LIMIT 600',
    });
    const groups = [];
    const seen = new Set();
    const items = rows.map((t) => {
      if (t.business_id && !seen.has(t.business_id)) {
        seen.add(t.business_id);
        groups.push({ id: t.business_id, name: t.business_name || 'Business', description: '', color: t.business_color || 'blue', sort_order: groups.length + 1, archived: false });
      }
      return { ...t, business_section_id: t.parent_id ? null : (t.business_id || null), permissions: { ...WATCHER_PERMISSIONS } };
    });

    const columns = BOARD_COLUMNS.map((key, i) => {
      const def = SYSTEM_COLUMNS[key];
      const col = { id: i + 1, board_id: 0, kind: def.kind, title: def.title, system_key: key, width: def.width || 150, sort_order: i + 1, settings: def.settings || {}, archived_at: null };
      if (def.kind === 'status') col.labels = DEFAULT_STATUS_LABELS.map((l, n) => ({ id: n + 1, column_id: col.id, ...l, sort_order: n + 1 }));
      return col;
    });
    const views = [
      { id: 1, kind: 'table', name: 'Main table', settings: {}, owner_id: null, sort_order: 1 },
      { id: 2, kind: 'kanban', name: 'Kanban', settings: { group_by: 'status' }, owner_id: null, sort_order: 2 },
      { id: 3, kind: 'calendar', name: 'Calendar', settings: {}, owner_id: null, sort_order: 3 },
      { id: 4, kind: 'gantt', name: 'Gantt', settings: {}, owner_id: null, sort_order: 4 },
    ];

    res.json({
      board: {
        id: 0, scope: 'personal', kind: 'monitor', name: `${person.name}'s board`, description: '', icon: 'people-outline',
        color: 'blue', privacy: 'private', item_word: 'Task', business_id: null, person_id: personId,
      },
      access: { view: true, add: false, manage: false, role: 'watcher' },
      members: [],
      columns,
      groups,
      views,
      items,
      values: {},
      attachments: {},
      linked: {},
      mirrors: {},
      backlinks: {},
      ai_enabled: false,
      person,
      today: todayInAppZone(),
    });
  } catch (err) {
    next(err);
  }
});

const niceWhen = (d, t) => {
  if (!d) return 'none';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  const text = new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return t ? `${text}, ${t}` : text;
};
const PRIORITY_NAME = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };

/** A monitored person (never the viewer) who is on the to-do, or null: the only way in for changing things. */
function monitoredMember(req, members) {
  return members.find((id) => id !== req.user.id && req.monitor.ids.has(id)) || null;
}

/** The people who must hear that a manager touched a to-do: whoever does it and everyone on it. */
async function audienceOf(todo, members, actorId) {
  return [...new Set([todo.assignee_id, ...members].filter((id) => id && id !== actorId))];
}

// PATCH /api/monitor/todos/:id — { due_date, due_time, deadline_date, deadline_time, remind_date, remind_time, remind_repeat,
// priority, note }. Only these; the person's own work (title, owner, status) stays theirs. Everything changed is written
// to the activity, an automatic comment asks them to check again, and they get a notification.
router.patch('/todos/:id(\\d+)', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const { parseDate, parseTime, parsePriority } = require('./todos');
    const todoId = parseInt(req.params.id, 10);
    const members = await memberIds(todoId);
    const through = monitoredMember(req, members);
    if (!through) return res.status(404).json({ error: 'To-do not found' });
    const existing = await getTodoFor(todoId, through);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });
    const b = req.body || {};

    const dueDate = b.due_date !== undefined ? parseDate(b.due_date) : existing.due_date;
    const dueTime = !dueDate ? null : b.due_time !== undefined ? parseTime(b.due_time) : existing.due_time;
    const deadlineDate = b.deadline_date !== undefined ? parseDate(b.deadline_date) : existing.deadline_date;
    const deadlineTime = !deadlineDate ? null : b.deadline_time !== undefined ? parseTime(b.deadline_time) : (existing.deadline_time || null);
    const priority = b.priority !== undefined ? parsePriority(b.priority, existing.priority) : existing.priority;
    let rDate = b.remind_date !== undefined ? parseDate(b.remind_date) : (existing.remind_date || null);
    let rTime = b.remind_time !== undefined ? parseTime(b.remind_time) : (existing.remind_time || null);
    let rRepeat = b.remind_repeat !== undefined ? (['daily', 'weekly', 'monthly'].includes(b.remind_repeat) ? b.remind_repeat : null) : (existing.remind_repeat || null);
    if (!rDate || !rTime) { rDate = null; rTime = null; rRepeat = null; }

    const scheduleChanged = dueDate !== (existing.due_date || null) || dueTime !== (existing.due_time || null);
    const deadlineChanged = deadlineDate !== (existing.deadline_date || null) || deadlineTime !== (existing.deadline_time || null);
    const priorityChanged = priority !== existing.priority;
    const remindChanged = rDate !== (existing.remind_date || null) || rTime !== (existing.remind_time || null) || rRepeat !== (existing.remind_repeat || null);
    if (!scheduleChanged && !deadlineChanged && !priorityChanged && !remindChanged) return res.json({ todo: existing, changed: [] });

    await db.query(
      `UPDATE todos SET due_date = $1, due_time = $2, deadline_date = $3, deadline_time = $4, priority = $5,
         remind_date = $6, remind_time = $7, remind_repeat = $8,
         reminded_at = CASE WHEN $9::boolean THEN NULL ELSE reminded_at END,
         last_overdue_notification_at = CASE WHEN $9::boolean THEN NULL ELSE last_overdue_notification_at END,
         reminders_sent = CASE WHEN $9::boolean THEN '{}'::int[] ELSE reminders_sent END,
         remind_sent_at = CASE WHEN $10::boolean THEN NULL ELSE remind_sent_at END
       WHERE id = $11`,
      [dueDate, dueTime, deadlineDate, deadlineTime, priority, rDate, rTime, rRepeat, scheduleChanged, remindChanged, todoId]
    );
    if (dueDate !== (existing.due_date || null)) await followDueChange(existing, existing.due_date, dueDate, req.user.id);

    const evt = { todoId, userId: req.user.id, subjectId: existing.assignee_id, meta: { via: 'monitor' } };
    const said = [];
    if (scheduleChanged) {
      await logEvent({ ...evt, kind: 'due_changed', from: existing.due_date ? `${existing.due_date}${existing.due_time ? ` ${existing.due_time}` : ''}` : null, to: dueDate ? `${dueDate}${dueTime ? ` ${dueTime}` : ''}` : null });
      said.push(`due date ${niceWhen(existing.due_date, existing.due_time)} to ${niceWhen(dueDate, dueTime)}`);
    }
    if (deadlineChanged) {
      await logEvent({ ...evt, kind: 'deadline_changed', from: existing.deadline_date, to: deadlineDate });
      said.push(`deadline ${niceWhen(existing.deadline_date, existing.deadline_time)} to ${niceWhen(deadlineDate, deadlineTime)}`);
    }
    if (priorityChanged) {
      await logEvent({ ...evt, kind: 'priority_changed', from: `P${existing.priority}`, to: `P${priority}` });
      said.push(`priority ${PRIORITY_NAME[existing.priority]} to ${PRIORITY_NAME[priority]}`);
    }
    if (remindChanged) {
      const was = existing.remind_date ? niceWhen(existing.remind_date, existing.remind_time) : 'none';
      const now = rDate ? `${niceWhen(rDate, rTime)}${rRepeat ? `, ${rRepeat}` : ''}` : 'removed';
      await logEvent({ ...evt, kind: 'edited', note: `Reminder ${was} to ${now}` });
      said.push(`reminder ${was} to ${now}`);
    }

    const who = (await db.query('SELECT name FROM users WHERE id = $1', [req.user.id])).rows[0]?.name || 'A manager';
    const extra = sanitizeText(b.note, 500);
    const body = `Updated ${said.join('; ')}. The task was updated, please check it once again.${extra ? ` ${extra}` : ''}`;
    await db.query(`INSERT INTO todo_comments (todo_id, user_id, body, kind) VALUES ($1, $2, $3, 'comment')`, [todoId, req.user.id, body]);

    const audience = await audienceOf(existing, members, req.user.id);
    await notify(audience, {
      type: 'todo_adjusted',
      title: `${who} updated a task`,
      body: `${existing.title}: ${said.join('; ')}. Check it once again.`,
      data: { todoId },
    }, { exclude: [req.user.id] });
    emitToUsers([...new Set([...members, req.user.id])], 'todo:changed', { todoId, action: 'updated' });
    res.json({ todo: await getTodoFor(todoId, through), changed: said });
  } catch (err) {
    next(err);
  }
});

// POST /api/monitor/todos/:id/comments — { message } a plain comment from a manager in the activity box
router.post('/todos/:id(\\d+)/comments', authenticate, requireMonitor, async (req, res, next) => {
  try {
    const todoId = parseInt(req.params.id, 10);
    const members = await memberIds(todoId);
    const through = monitoredMember(req, members);
    if (!through) return res.status(404).json({ error: 'To-do not found' });
    const message = sanitizeText(req.body.message, 2000);
    if (!message) return res.status(400).json({ error: 'Write a comment' });
    const todo = await getTodoFor(todoId, through);
    const inserted = await db.query(
      `INSERT INTO todo_comments (todo_id, user_id, body, kind) VALUES ($1, $2, $3, 'comment') RETURNING id`,
      [todoId, req.user.id, message]
    );
    const who = (await db.query('SELECT name FROM users WHERE id = $1', [req.user.id])).rows[0]?.name || 'A manager';
    await notify(await audienceOf(todo, members, req.user.id), {
      type: 'todo_comment',
      title: `${who} commented`,
      body: `${todo.title}: ${message.slice(0, 140)}`,
      data: { todoId },
    }, { exclude: [req.user.id] });
    emitToUsers([...new Set([...members, req.user.id])], 'todo:changed', { todoId, action: 'commented' });
    res.status(201).json({ id: inserted.rows[0].id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
