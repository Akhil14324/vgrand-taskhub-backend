const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { resolveMentions } = require('../utils/mentions');
const { deliverMessage } = require('../services/chatDelivery');
const { todayInAppZone, nextOccurrence, APP_TIMEZONE } = require('../utils/recurrence');
const { completionSnapshot } = require('../utils/timeline');
const { TODO_SELECT, getTodoFor, memberIds } = require('../services/todoQueries');
const {
  logEvent, setStatus, resolveOpenBlockers, assignTodo, releaseDependents,
} = require('../services/todoTimeline');

const router = express.Router();

const LIST_COLORS = ['indigo', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
// Minutes before the due time at which an extra reminder may fire.
const REMINDER_OFFSETS = [5, 10, 15, 30, 60, 120, 1440, 2880];
const FILTER_DUE = ['any', 'overdue', 'today', 'week', 'nodate'];
const FILTER_ASSIGNED = ['any', 'mine', 'others', 'shared'];

function parsePriority(value, fallback = 4) {
  const n = parseInt(value, 10);
  return n >= 1 && n <= 4 ? n : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseTime(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Labels are lower-case words (letters, digits, - and _), at most 10 per to-do. */
function parseLabels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const label = String(raw || '').toLowerCase().replace(/^[#+@]+/, '').replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= 10) break;
  }
  return out;
}

function parseDuration(value) {
  if (value === null || value === '' || value === undefined) return null;
  const n = parseInt(value, 10);
  return n >= 1 && n <= 14400 ? n : null;
}

function parseOffsets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => REMINDER_OFFSETS.includes(n)))].sort((a, b) => a - b);
}

/** Saved filters are evaluated on the client; only known keys and values are stored. */
function parseFilterConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const listId = c.list_id === 'inbox' ? 'inbox' : (parseInt(c.list_id, 10) || null);
  return {
    due: FILTER_DUE.includes(c.due) ? c.due : 'any',
    priorities: [...new Set((Array.isArray(c.priorities) ? c.priorities : []).map(Number).filter((p) => p >= 1 && p <= 4))],
    labels: parseLabels(c.labels),
    list_id: listId,
    assigned: FILTER_ASSIGNED.includes(c.assigned) ? c.assigned : 'any',
  };
}

async function childIds(todoId) {
  const result = await db.query('SELECT id FROM todos WHERE parent_id = $1', [todoId]);
  return result.rows.map((r) => r.id);
}

async function ownsList(listId, userId) {
  if (!listId) return true;
  const result = await db.query('SELECT 1 FROM todo_lists WHERE id = $1 AND owner_id = $2', [listId, userId]);
  return result.rows.length > 0;
}

/**
 * Where a to-do sits in *my* lists. A section implies its list. Returns { listId, sectionId }
 * or { error } when the list/section is not mine.
 */
async function resolvePlacement(userId, listId, sectionId) {
  if (sectionId) {
    const result = await db.query(
      `SELECT s.id, s.list_id FROM todo_sections s JOIN todo_lists l ON l.id = s.list_id
       WHERE s.id = $1 AND l.owner_id = $2`,
      [sectionId, userId]
    );
    if (!result.rows.length) return { error: 'Section not found' };
    return { listId: result.rows[0].list_id, sectionId };
  }
  if (!(await ownsList(listId, userId))) return { error: 'List not found' };
  return { listId: listId || null, sectionId: null };
}

async function currentUser(userId) {
  const result = await db.query('SELECT id, name, username FROM users WHERE id = $1', [userId]);
  return result.rows[0];
}

/** Add @mentioned people to a to-do (and its sub-tasks) and tell them about it. Returns added user ids. */
async function addMentionedMembers(todo, text, explicitIds, actor, { quietFor = null } = {}) {
  const mentioned = await resolveMentions(text, explicitIds);
  const existing = new Set(await memberIds(todo.id));
  const added = mentioned.filter((m) => !existing.has(m.id) && m.id !== actor.id);
  const subject = (await db.query('SELECT assignee_id FROM todos WHERE id = $1', [todo.id])).rows[0]?.assignee_id;
  for (const m of added) {
    await db.query(
      `INSERT INTO todo_members (todo_id, user_id, list_id, added_by) VALUES ($1, $2, NULL, $3)
       ON CONFLICT DO NOTHING`,
      [todo.id, m.id, actor.id]
    );
    await logEvent({ todoId: todo.id, userId: actor.id, subjectId: subject, kind: 'shared', to: m.name, meta: { user_id: m.id } });
    await db.query(
      `INSERT INTO todo_members (todo_id, user_id, list_id, added_by)
       SELECT c.id, $2::int, NULL::int, $3::int FROM todos c WHERE c.parent_id = $1
       ON CONFLICT DO NOTHING`,
      [todo.id, m.id, actor.id]
    );
  }
  if (added.length) {
    await notify(added.map((m) => m.id).filter((id) => id !== quietFor), {
      type: 'todo_shared',
      title: `📝 ${actor.name} added a to-do for you`,
      body: todo.title,
      data: { todoId: todo.id },
    });
  }
  return added.map((m) => m.id);
}

/** Everyone on the parent also sits on its new sub-task; my own copy keeps the parent's placement. */
async function attachSubtaskMembers(subtaskId, parent, userId) {
  await db.query(
    `INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by)
     SELECT $1::int, m.user_id, CASE WHEN m.user_id = $3::int THEN $4::int END, CASE WHEN m.user_id = $3::int THEN $5::int END, $3::int
     FROM todo_members m WHERE m.todo_id = $2
     ON CONFLICT DO NOTHING`,
    [subtaskId, parent.id, userId, parent.list_id, parent.section_id]
  );
}

function broadcast(userIds, todoId, action = 'updated') {
  emitToUsers(userIds, 'todo:changed', { todoId: Number(todoId), action });
}

// GET /api/todos — my lists and every to-do I'm part of (open + done in the last 30 days)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const [lists, sections, filters, todos] = await Promise.all([
      db.query('SELECT * FROM todo_lists WHERE owner_id = $1 ORDER BY sort_order, id', [req.user.id]),
      db.query(
        `SELECT s.* FROM todo_sections s JOIN todo_lists l ON l.id = s.list_id
         WHERE l.owner_id = $1 ORDER BY s.sort_order, s.id`,
        [req.user.id]
      ),
      db.query('SELECT * FROM todo_filters WHERE owner_id = $1 ORDER BY sort_order, id', [req.user.id]),
      db.query(
        `${TODO_SELECT}
         WHERE tm.user_id = $1 AND (t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '30 days')
         ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.due_time ASC NULLS LAST, t.priority ASC, t.created_at DESC`,
        [req.user.id]
      ),
    ]);
    res.json({
      lists: lists.rows,
      sections: sections.rows,
      filters: filters.rows,
      todos: todos.rows,
      today: todayInAppZone(),
      timezone: APP_TIMEZONE,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/completed?before=<ISO time> — completion history, newest first, 40 per page.
// Sub-tasks that were completed together with their parent are left out.
router.get('/completed', authenticate, async (req, res, next) => {
  try {
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before))
      ? new Date(req.query.before).toISOString()
      : null;
    const result = await db.query(
      `${TODO_SELECT}
       WHERE tm.user_id = $1 AND t.is_done = TRUE AND t.done_at IS NOT NULL
         AND ($2::timestamptz IS NULL OR t.done_at < $2)
         AND NOT EXISTS (SELECT 1 FROM todos p WHERE p.id = t.parent_id AND p.is_done = TRUE)
       ORDER BY t.done_at DESC
       LIMIT 41`,
      [req.user.id, before]
    );
    res.json({ todos: result.rows.slice(0, 40), has_more: result.rows.length > 40 });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/insights — completions per day for the last 7 days + streak + daily goal
router.get('/insights', authenticate, async (req, res, next) => {
  try {
    const [result, goalRow] = await Promise.all([
      db.query(
        `SELECT d::text AS day, COUNT(*)::int AS count FROM (
           SELECT (done_at AT TIME ZONE $2)::date AS d FROM todos
             WHERE done_by = $1 AND done_at > NOW() - INTERVAL '90 days'
           UNION ALL
           SELECT (completed_at AT TIME ZONE $2)::date FROM tasks
             WHERE completed_by = $1 AND status = 'completed' AND completed_at > NOW() - INTERVAL '90 days'
         ) x GROUP BY d`,
        [req.user.id, APP_TIMEZONE]
      ),
      db.query('SELECT todo_daily_goal FROM users WHERE id = $1', [req.user.id]),
    ]);
    const byDay = new Map(result.rows.map((r) => [r.day, r.count]));
    const today = todayInAppZone();
    const shift = (ymd, delta) => {
      const [y, m, d] = ymd.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + delta));
      return dt.toISOString().slice(0, 10);
    };

    const week = [];
    for (let i = 6; i >= 0; i--) {
      const day = shift(today, -i);
      week.push({ day, count: byDay.get(day) || 0 });
    }
    // A streak survives until the end of today even if nothing is done yet today.
    let streak = 0;
    let cursor = byDay.get(today) ? today : shift(today, -1);
    while (byDay.get(cursor)) {
      streak += 1;
      cursor = shift(cursor, -1);
    }
    res.json({
      week,
      streak,
      today_count: byDay.get(today) || 0,
      today,
      goal: goalRow.rows[0]?.todo_daily_goal || 5,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/todos/goal — { goal } daily completion target (declared before /:id)
router.put('/goal', authenticate, async (req, res, next) => {
  try {
    const goal = parseInt(req.body.goal, 10);
    if (!(goal >= 1 && goal <= 50)) return res.status(400).json({ error: 'Pick a goal between 1 and 50' });
    await db.query('UPDATE users SET todo_daily_goal = $1 WHERE id = $2', [goal, req.user.id]);
    res.json({ goal });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/reorder — { ids: [...] } puts these to-dos in that order in *my* lists
router.post('/reorder', authenticate, async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 500);
    if (!ids.length) return res.json({ reordered: 0 });
    await db.query(
      `UPDATE todo_members tm SET sort_order = o.ord::int
       FROM unnest($2::int[]) WITH ORDINALITY AS o(id, ord)
       WHERE tm.todo_id = o.id AND tm.user_id = $1`,
      [req.user.id, ids]
    );
    res.json({ reordered: ids.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos — { title, notes?, due_date?, due_time?, priority?, list_id?, section_id?, recurrence?,
//                     mention_ids?, parent_id?, labels?, deadline_date?, duration_minutes?, reminder_offsets? }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const title = sanitizeText(req.body.title, 500);
    if (!title) return res.status(400).json({ error: 'What needs to be done?' });
    const notes = sanitizeText(req.body.notes, 5000);

    let parent = null;
    const parentId = parseInt(req.body.parent_id, 10) || null;
    if (parentId) {
      parent = await getTodoFor(parentId, req.user.id);
      if (!parent) return res.status(404).json({ error: 'To-do not found' });
      if (parent.parent_id) return res.status(400).json({ error: 'Sub-tasks can only go one level deep' });
    }

    const place = await resolvePlacement(
      req.user.id,
      parseInt(req.body.list_id, 10) || null,
      parseInt(req.body.section_id, 10) || null
    );
    if (place.error) return res.status(404).json({ error: place.error });

    const recurrence = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null;
    const dueDate = parseDate(req.body.due_date) || (recurrence ? todayInAppZone() : null);
    const dueTime = parseTime(req.body.due_time);

    const inserted = await db.query(
      `INSERT INTO todos (created_by, title, notes, due_date, due_time, priority, recurrence,
                          parent_id, labels, deadline_date, duration_minutes, reminder_offsets,
                          assignee_id, assigned_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $1, NOW()) RETURNING id, title`,
      [
        req.user.id, title, notes || '', dueDate, dueTime, parsePriority(req.body.priority), recurrence,
        parent ? parent.id : null, parseLabels(req.body.labels), parseDate(req.body.deadline_date),
        parseDuration(req.body.duration_minutes), dueTime ? parseOffsets(req.body.reminder_offsets) : [],
      ]
    );
    const todo = inserted.rows[0];
    if (parent) {
      await attachSubtaskMembers(todo.id, parent, req.user.id);
    } else {
      await db.query(
        'INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by) VALUES ($1, $2, $3, $4, $2)',
        [todo.id, req.user.id, place.listId, place.sectionId]
      );
    }

    await logEvent({
      todoId: todo.id, userId: req.user.id, subjectId: req.user.id, kind: 'created',
      meta: { title, parent_id: parent ? parent.id : null },
    });

    const actor = await currentUser(req.user.id);
    const added = await addMentionedMembers(todo, `${title} ${notes || ''}`, req.body.mention_ids, actor, {
      quietFor: parseInt(req.body.assign_to, 10) || null,
    });

    // "Assign to @ravi": the person who is accountable, not just a collaborator.
    const assignTo = parseInt(req.body.assign_to, 10);
    if (assignTo && added.includes(assignTo)) await assignTodo(todo, assignTo, actor);

    const members = await memberIds(todo.id);
    broadcast(members, todo.id, 'created');
    res.status(201).json({ todo: await getTodoFor(todo.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/import — { items: [{ title, notes?, due_date?, priority? }], list_id? }
// Copies to-dos someone shared in chat into my own list.
router.post('/import', authenticate, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    const listId = parseInt(req.body.list_id) || null;
    if (!(await ownsList(listId, req.user.id))) return res.status(404).json({ error: 'List not found' });
    let created = 0;
    for (const item of items) {
      const title = sanitizeText(item.title, 500);
      if (!title) continue;
      const inserted = await db.query(
        `INSERT INTO todos (created_by, title, notes, due_date, priority) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.user.id, title, sanitizeText(item.notes, 5000) || '', parseDate(item.due_date), parsePriority(item.priority)]
      );
      await db.query(
        'INSERT INTO todo_members (todo_id, user_id, list_id, added_by) VALUES ($1, $2, $3, $2)',
        [inserted.rows[0].id, req.user.id, listId]
      );
      created += 1;
    }
    broadcast([req.user.id], 0, 'imported');
    res.status(201).json({ created });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/share — { conversation_ids: [], todo_ids: [], title?, note? }
router.post('/share', authenticate, async (req, res, next) => {
  try {
    const conversationIds = [...new Set((req.body.conversation_ids || []).map(Number).filter(Boolean))].slice(0, 20);
    const todoIds = [...new Set((req.body.todo_ids || []).map(Number).filter(Boolean))].slice(0, 100);
    if (!conversationIds.length || !todoIds.length) {
      return res.status(400).json({ error: 'Pick at least one chat and one to-do' });
    }

    const todos = await db.query(
      `${TODO_SELECT} WHERE tm.user_id = $1 AND t.id = ANY($2::int[])
       ORDER BY t.is_done, t.due_date NULLS LAST, t.priority`,
      [req.user.id, todoIds]
    );
    if (!todos.rows.length) return res.status(404).json({ error: 'To-dos not found' });

    const allowed = await db.query(
      `SELECT conversation_id FROM conversation_participants
       WHERE user_id = $1 AND conversation_id = ANY($2::int[])`,
      [req.user.id, conversationIds]
    );
    if (!allowed.rows.length) return res.status(403).json({ error: 'You are not in those chats' });

    const actor = await currentUser(req.user.id);
    const meta = {
      kind: 'todos',
      title: sanitizeText(req.body.title, 120) || null,
      owner: { id: actor.id, name: actor.name },
      items: todos.rows.map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes || '',
        due_date: t.due_date,
        due_time: t.due_time,
        priority: t.priority,
        is_done: t.is_done,
      })),
    };
    const note = sanitizeText(req.body.note, 2000) || null;
    const io = req.app.get('io');
    for (const row of allowed.rows) {
      await deliverMessage(io, {
        conversationId: row.conversation_id,
        sender: { id: actor.id, name: actor.name },
        body: note,
        meta,
      });
    }
    res.status(201).json({ shared: allowed.rows.length });
  } catch (err) {
    next(err);
  }
});

// PUT /api/todos/:id — edit (any member); list_id / section_id only move it in *my* lists
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });

    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 500) : existing.title;
    if (!title) return res.status(400).json({ error: 'Title cannot be empty' });
    const notes = req.body.notes !== undefined ? sanitizeText(req.body.notes, 5000) : existing.notes;
    const dueDate = req.body.due_date !== undefined ? parseDate(req.body.due_date) : existing.due_date;
    const dueTime = req.body.due_time !== undefined ? parseTime(req.body.due_time) : existing.due_time;
    const priority = req.body.priority !== undefined ? parsePriority(req.body.priority, existing.priority) : existing.priority;
    const recurrence = req.body.recurrence !== undefined
      ? (RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null)
      : existing.recurrence;
    const labels = req.body.labels !== undefined ? parseLabels(req.body.labels) : existing.labels;
    const deadline = req.body.deadline_date !== undefined ? parseDate(req.body.deadline_date) : existing.deadline_date;
    const duration = req.body.duration_minutes !== undefined ? parseDuration(req.body.duration_minutes) : existing.duration_minutes;
    const offsets = dueTime
      ? (req.body.reminder_offsets !== undefined ? parseOffsets(req.body.reminder_offsets) : existing.reminder_offsets)
      : [];
    const scheduleChanged = dueDate !== existing.due_date || dueTime !== existing.due_time;
    const offsetsChanged = JSON.stringify(offsets) !== JSON.stringify(existing.reminder_offsets);

    // Validate placement / nesting before touching anything.
    const touchesPlacement = req.body.list_id !== undefined || req.body.section_id !== undefined;
    let place = null;
    if (touchesPlacement) {
      const listId = req.body.list_id !== undefined ? (parseInt(req.body.list_id, 10) || null) : existing.list_id;
      const sectionId = req.body.section_id !== undefined
        ? (parseInt(req.body.section_id, 10) || null)
        : (listId === existing.list_id ? existing.section_id : null);
      place = await resolvePlacement(req.user.id, listId, sectionId);
      if (place.error) return res.status(404).json({ error: place.error });
    }

    let newParent;
    if (req.body.parent_id !== undefined) {
      newParent = parseInt(req.body.parent_id, 10) || null;
      if (newParent) {
        if (newParent === existing.id) return res.status(400).json({ error: 'A to-do cannot be its own sub-task' });
        if (existing.subtask_count > 0) return res.status(400).json({ error: 'A to-do with sub-tasks cannot become a sub-task' });
        const parent = await getTodoFor(newParent, req.user.id);
        if (!parent) return res.status(404).json({ error: 'To-do not found' });
        if (parent.parent_id) return res.status(400).json({ error: 'Sub-tasks can only go one level deep' });
        place = { listId: parent.list_id, sectionId: parent.section_id };
      }
    }

    await db.query(
      `UPDATE todos SET title = $1, notes = $2, due_date = $3, due_time = $4, priority = $5, recurrence = $6,
         labels = $7, deadline_date = $8, duration_minutes = $9, reminder_offsets = $10,
         reminded_at = CASE WHEN $11::boolean THEN NULL ELSE reminded_at END,
         reminders_sent = CASE WHEN $11::boolean OR $12::boolean THEN '{}'::int[] ELSE reminders_sent END
       WHERE id = $13`,
      [title, notes || '', dueDate, dueTime, priority, recurrence, labels, deadline, duration, offsets,
        scheduleChanged, offsetsChanged, existing.id]
    );
    if (newParent !== undefined) {
      await db.query('UPDATE todos SET parent_id = $1 WHERE id = $2', [newParent, existing.id]);
    }

    // Timeline: schedule and priority changes are what a manager asks about ("why was this moved?").
    const when = (d, t) => (d ? `${d}${t ? ` ${t}` : ''}` : null);
    const evt = { todoId: existing.id, userId: req.user.id, subjectId: existing.assignee_id };
    if (scheduleChanged) {
      await logEvent({ ...evt, kind: 'due_changed', from: when(existing.due_date, existing.due_time), to: when(dueDate, dueTime) });
    }
    if (deadline !== existing.deadline_date) {
      await logEvent({ ...evt, kind: 'deadline_changed', from: existing.deadline_date, to: deadline });
    }
    if (priority !== existing.priority) {
      await logEvent({ ...evt, kind: 'priority_changed', from: `P${existing.priority}`, to: `P${priority}` });
    }

    if (place) {
      await db.query(
        'UPDATE todo_members SET list_id = $1, section_id = $2 WHERE todo_id = $3 AND user_id = $4',
        [place.listId, place.sectionId, existing.id, req.user.id]
      );
      // Sub-tasks stay with their parent in my lists.
      await db.query(
        `UPDATE todo_members SET list_id = $1, section_id = $2
         WHERE user_id = $3 AND todo_id IN (SELECT id FROM todos WHERE parent_id = $4)`,
        [place.listId, place.sectionId, req.user.id, existing.id]
      );
    }

    const actor = await currentUser(req.user.id);
    await addMentionedMembers({ id: existing.id, title }, `${title} ${notes || ''}`, req.body.mention_ids, actor);

    broadcast(await memberIds(existing.id), existing.id);
    res.json({ todo: await getTodoFor(existing.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/toggle — tick / untick (any member). Recurring to-dos roll forward.
// Ticking a parent ticks its sub-tasks; reopening a sub-task reopens a finished parent.
router.post('/:id/toggle', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });

    const actor = await currentUser(req.user.id);
    let rolledTo = null;

    const evt = { todoId: existing.id, userId: req.user.id, subjectId: existing.assignee_id };

    if (!existing.is_done && existing.recurrence) {
      const snapshot = completionSnapshot(existing);
      rolledTo = nextOccurrence(existing.due_date || todayInAppZone(), existing.recurrence, todayInAppZone());
      await db.query(
        `UPDATE todos SET due_date = $1, reminded_at = NULL, reminders_sent = '{}', done_at = NOW(), done_by = $2 WHERE id = $3`,
        [rolledTo, req.user.id, existing.id]
      );
      await resolveOpenBlockers(existing.id, req.user.id, 'Completed');
      // A new round starts: sub-tasks are unticked again and every clock restarts.
      await db.query(
        `UPDATE todos SET status = 'todo', status_since = NOW(), status_seconds = '{}'::jsonb, started_at = NULL, assigned_at = NOW()
         WHERE id = $1`,
        [existing.id]
      );
      await db.query(
        `UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL, status = 'todo', status_since = NOW(),
                status_seconds = '{}'::jsonb, started_at = NULL
         WHERE parent_id = $1`,
        [existing.id]
      );
      await logEvent({ ...evt, kind: 'completed', meta: { ...snapshot, recurring: true, next_due: rolledTo } });
    } else if (!existing.is_done) {
      const snapshot = completionSnapshot(existing);
      await db.query('UPDATE todos SET is_done = TRUE, done_at = NOW(), done_by = $1 WHERE id = $2', [req.user.id, existing.id]);
      await setStatus(existing.id, 'done');
      await resolveOpenBlockers(existing.id, req.user.id, 'Completed');
      await db.query(
        `UPDATE todos SET is_done = TRUE, done_at = NOW(), done_by = $1, status = 'done', status_since = NOW()
         WHERE parent_id = $2 AND is_done = FALSE`,
        [req.user.id, existing.id]
      );
      await logEvent({ ...evt, kind: 'completed', meta: snapshot });
      await releaseDependents(existing.id, actor);
    } else {
      const target = existing.started_at ? 'in_progress' : 'todo';
      await db.query('UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL WHERE id = $1', [existing.id]);
      await setStatus(existing.id, target);
      await logEvent({ ...evt, kind: 'reopened', to: target });
      if (existing.parent_id) {
        const parent = (await db.query('SELECT id, assignee_id, started_at, is_done FROM todos WHERE id = $1', [existing.parent_id])).rows[0];
        if (parent && parent.is_done) {
          await db.query('UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL WHERE id = $1', [parent.id]);
          const parentTarget = parent.started_at ? 'in_progress' : 'todo';
          await setStatus(parent.id, parentTarget);
          await logEvent({ todoId: parent.id, userId: req.user.id, subjectId: parent.assignee_id, kind: 'reopened', to: parentTarget, note: 'A sub-task was reopened' });
        }
      }
    }

    const members = await memberIds(existing.id);
    if (!existing.is_done && members.length > 1) {
      await notify(members, {
        type: 'todo_done',
        title: `✔️ ${actor.name} ticked off a shared to-do`,
        body: existing.title,
        data: { todoId: existing.id },
      }, { exclude: [req.user.id] });
    }

    broadcast(members, existing.id);
    res.json({ todo: await getTodoFor(existing.id, req.user.id), rolled_to: rolledTo });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/duplicate — copy (with its sub-tasks) into my own list
router.post('/:id/duplicate', authenticate, async (req, res, next) => {
  try {
    const src = await getTodoFor(req.params.id, req.user.id);
    if (!src) return res.status(404).json({ error: 'To-do not found' });

    const copy = async (row, parentId) => {
      const inserted = await db.query(
        `INSERT INTO todos (created_by, title, notes, due_date, due_time, priority, recurrence,
                            parent_id, labels, deadline_date, duration_minutes, reminder_offsets)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [req.user.id, row.title, row.notes || '', row.due_date, row.due_time, row.priority, row.recurrence,
          parentId, row.labels || [], row.deadline_date, row.duration_minutes, row.reminder_offsets || []]
      );
      return inserted.rows[0].id;
    };

    const newId = await copy(src, src.parent_id);
    if (src.parent_id) {
      const parent = await getTodoFor(src.parent_id, req.user.id);
      await attachSubtaskMembers(newId, parent, req.user.id);
    } else {
      await db.query(
        'INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by) VALUES ($1, $2, $3, $4, $2)',
        [newId, req.user.id, src.list_id, src.section_id]
      );
      const children = await db.query(
        `${TODO_SELECT} WHERE tm.user_id = $1 AND t.parent_id = $2 ORDER BY t.id`,
        [req.user.id, src.id]
      );
      for (const child of children.rows) {
        const childCopy = await copy(child, newId);
        await db.query(
          'INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by) VALUES ($1, $2, $3, $4, $2)',
          [childCopy, req.user.id, src.list_id, src.section_id]
        );
      }
    }

    broadcast([req.user.id], newId, 'created');
    res.status(201).json({ todo: await getTodoFor(newId, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/:id — creator deletes for everyone; others just leave it
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });
    const members = await memberIds(existing.id);

    if (existing.created_by === req.user.id) {
      // The log outlives the to-do: deleting does not erase the record of it.
      await logEvent({
        todoId: null, userId: req.user.id, subjectId: existing.assignee_id, kind: 'deleted',
        meta: {
          title: existing.title, status: existing.status, was_done: existing.is_done,
          created_at: existing.created_at, due_date: existing.due_date,
        },
      });
      await db.query('DELETE FROM todos WHERE id = $1', [existing.id]);
      broadcast(members, existing.id, 'deleted');
      return res.json({ deleted: true });
    }
    await logEvent({
      todoId: existing.id, userId: req.user.id, subjectId: existing.assignee_id, kind: 'left',
      meta: { title: existing.title },
    });
    await db.query(
      `DELETE FROM todo_members WHERE user_id = $2
       AND (todo_id = $1 OR todo_id IN (SELECT id FROM todos WHERE parent_id = $1))`,
      [existing.id, req.user.id]
    );
    // Someone who walks away from a to-do cannot stay accountable for it: it goes back to its creator.
    if (existing.assignee_id === req.user.id) {
      const actor = await currentUser(req.user.id);
      await assignTodo({ id: existing.id, title: existing.title }, existing.created_by, actor);
    }
    broadcast(members, existing.id);
    res.json({ left: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/:id/members/:userId — creator removes someone from a shared to-do
router.delete('/:id/members/:userId', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });
    const targetId = parseInt(req.params.userId);
    if (existing.created_by !== req.user.id && targetId !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can remove people' });
    }
    if (targetId === existing.created_by) return res.status(400).json({ error: 'The creator cannot be removed' });
    const members = await memberIds(existing.id);
    await db.query(
      `DELETE FROM todo_members WHERE user_id = $2
       AND (todo_id = $1 OR todo_id IN (SELECT id FROM todos WHERE parent_id = $1))`,
      [existing.id, targetId]
    );
    if (existing.assignee_id === targetId) {
      await assignTodo({ id: existing.id, title: existing.title }, existing.created_by, await currentUser(req.user.id));
    }
    broadcast(members, existing.id);
    res.json({ todo: await getTodoFor(existing.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
const COMMENT_SELECT = `
  SELECT c.id, c.todo_id, c.user_id, c.body, c.kind, c.created_at,
         u.name AS user_name, u.username AS user_username, u.profile_picture AS user_picture
  FROM todo_comments c LEFT JOIN users u ON u.id = c.user_id`;

router.get('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });
    const result = await db.query(`${COMMENT_SELECT} WHERE c.todo_id = $1 ORDER BY c.created_at, c.id`, [existing.id]);
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/comments — { body, mention_ids? }
router.post('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });
    const body = sanitizeText(req.body.body, 2000);
    if (!body) return res.status(400).json({ error: 'Write a comment first' });

    const inserted = await db.query(
      'INSERT INTO todo_comments (todo_id, user_id, body) VALUES ($1, $2, $3) RETURNING id',
      [existing.id, req.user.id, body]
    );
    const actor = await currentUser(req.user.id);
    await addMentionedMembers({ id: existing.id, title: existing.title }, body, req.body.mention_ids, actor);

    const members = await memberIds(existing.id);
    // People who asked a question (e.g. a manager monitoring) hear about the answer too.
    const askers = (await db.query(
      `SELECT DISTINCT user_id FROM todo_comments WHERE todo_id = $1 AND kind = 'question' AND user_id IS NOT NULL`,
      [existing.id]
    )).rows.map((r) => r.user_id);
    await notify([...members, ...askers], {
      type: 'todo_comment',
      title: `💬 ${actor.name} commented`,
      body: `${existing.title}: ${body.slice(0, 120)}`,
      data: { todoId: existing.id },
    }, { exclude: [req.user.id] });
    broadcast(members, existing.id, 'commented');

    const comment = await db.query(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ comment: comment.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/comments/:commentId — author, or the to-do's creator
router.delete('/comments/:commentId', authenticate, async (req, res, next) => {
  try {
    const found = await db.query(
      `SELECT c.id, c.user_id, c.todo_id, t.created_by FROM todo_comments c
       JOIN todos t ON t.id = c.todo_id
       JOIN todo_members tm ON tm.todo_id = t.id AND tm.user_id = $2
       WHERE c.id = $1`,
      [req.params.commentId, req.user.id]
    );
    const row = found.rows[0];
    if (!row) return res.status(404).json({ error: 'Comment not found' });
    if (row.user_id !== req.user.id && row.created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    await db.query('DELETE FROM todo_comments WHERE id = $1', [row.id]);
    broadcast(await memberIds(row.todo_id), row.todo_id, 'commented');
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
router.post('/lists', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const color = LIST_COLORS.includes(req.body.color) ? req.body.color : 'indigo';
    const emoji = sanitizeText(req.body.emoji, 16) || null;
    const order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_lists WHERE owner_id = $1', [req.user.id]);
    const result = await db.query(
      `INSERT INTO todo_lists (owner_id, name, color, emoji, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, name, color, emoji, order.rows[0].next]
    );
    res.status(201).json({ list: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/lists/:id', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const color = LIST_COLORS.includes(req.body.color) ? req.body.color : 'indigo';
    const emoji = sanitizeText(req.body.emoji, 16) || null;
    const result = await db.query(
      `UPDATE todo_lists SET name = $1, color = $2, emoji = $3 WHERE id = $4 AND owner_id = $5 RETURNING *`,
      [name, color, emoji, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'List not found' });
    res.json({ list: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/lists/:id — its to-dos move back to the Inbox
router.delete('/lists/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM todo_lists WHERE id = $1 AND owner_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'List not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sections (inside one of my lists)
// ---------------------------------------------------------------------------
router.post('/lists/:id/sections', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Section name is required' });
    if (!(await ownsList(parseInt(req.params.id, 10), req.user.id))) return res.status(404).json({ error: 'List not found' });
    const order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_sections WHERE list_id = $1', [req.params.id]);
    const result = await db.query(
      'INSERT INTO todo_sections (list_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, name, order.rows[0].next]
    );
    res.status(201).json({ section: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/sections/:id', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Section name is required' });
    const result = await db.query(
      `UPDATE todo_sections s SET name = $1 FROM todo_lists l
       WHERE s.id = $2 AND l.id = s.list_id AND l.owner_id = $3 RETURNING s.*`,
      [name, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Section not found' });
    res.json({ section: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/sections/:id — its to-dos stay in the list, without a section
router.delete('/sections/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `DELETE FROM todo_sections s USING todo_lists l
       WHERE s.id = $1 AND l.id = s.list_id AND l.owner_id = $2 RETURNING s.id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Section not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Saved filters
// ---------------------------------------------------------------------------
router.post('/filters', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Filter name is required' });
    const order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_filters WHERE owner_id = $1', [req.user.id]);
    const result = await db.query(
      'INSERT INTO todo_filters (owner_id, name, config, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, name, JSON.stringify(parseFilterConfig(req.body.config)), order.rows[0].next]
    );
    res.status(201).json({ filter: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/filters/:id', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Filter name is required' });
    const result = await db.query(
      'UPDATE todo_filters SET name = $1, config = $2 WHERE id = $3 AND owner_id = $4 RETURNING *',
      [name, JSON.stringify(parseFilterConfig(req.body.config)), req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Filter not found' });
    res.json({ filter: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/filters/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM todo_filters WHERE id = $1 AND owner_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Filter not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
