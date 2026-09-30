const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { resolveMentions } = require('../utils/mentions');
const { deliverMessage } = require('../services/chatDelivery');
const { todayInAppZone, nextOccurrence, APP_TIMEZONE } = require('../utils/recurrence');

const router = express.Router();

const LIST_COLORS = ['indigo', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'];

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

const TODO_SELECT = `
  SELECT t.id, t.title, t.notes, t.due_date, to_char(t.due_time, 'HH24:MI') AS due_time,
         t.priority, t.recurrence, t.is_done, t.done_at, t.done_by, t.created_by, t.created_at, t.updated_at,
         tm.list_id,
         cu.name AS created_by_name, cu.username AS created_by_username,
         du.name AS done_by_name,
         (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username,
                                            'profile_picture', u.profile_picture) ORDER BY m2.added_at)
          FROM todo_members m2 JOIN users u ON u.id = m2.user_id
          WHERE m2.todo_id = t.id) AS members
  FROM todo_members tm
  JOIN todos t ON t.id = tm.todo_id
  JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users du ON du.id = t.done_by`;

async function getTodoFor(todoId, userId) {
  const result = await db.query(`${TODO_SELECT} WHERE tm.user_id = $1 AND t.id = $2`, [userId, todoId]);
  return result.rows[0] || null;
}

async function memberIds(todoId) {
  const result = await db.query('SELECT user_id FROM todo_members WHERE todo_id = $1', [todoId]);
  return result.rows.map((r) => r.user_id);
}

async function ownsList(listId, userId) {
  if (!listId) return true;
  const result = await db.query('SELECT 1 FROM todo_lists WHERE id = $1 AND owner_id = $2', [listId, userId]);
  return result.rows.length > 0;
}

async function currentUser(userId) {
  const result = await db.query('SELECT id, name, username FROM users WHERE id = $1', [userId]);
  return result.rows[0];
}

/** Add @mentioned people to a to-do and tell them about it. Returns added user ids. */
async function addMentionedMembers(todo, text, explicitIds, actor) {
  const mentioned = await resolveMentions(text, explicitIds);
  const existing = new Set(await memberIds(todo.id));
  const added = mentioned.filter((m) => !existing.has(m.id) && m.id !== actor.id);
  for (const m of added) {
    await db.query(
      `INSERT INTO todo_members (todo_id, user_id, list_id, added_by) VALUES ($1, $2, NULL, $3)
       ON CONFLICT DO NOTHING`,
      [todo.id, m.id, actor.id]
    );
  }
  if (added.length) {
    await notify(added.map((m) => m.id), {
      type: 'todo_shared',
      title: `📝 ${actor.name} added a to-do for you`,
      body: todo.title,
      data: { todoId: todo.id },
    });
  }
  return added.map((m) => m.id);
}

function broadcast(userIds, todoId, action = 'updated') {
  emitToUsers(userIds, 'todo:changed', { todoId: Number(todoId), action });
}

// GET /api/todos — my lists and every to-do I'm part of (open + done in the last 30 days)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const [lists, todos] = await Promise.all([
      db.query('SELECT * FROM todo_lists WHERE owner_id = $1 ORDER BY sort_order, id', [req.user.id]),
      db.query(
        `${TODO_SELECT}
         WHERE tm.user_id = $1 AND (t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '30 days')
         ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.due_time ASC NULLS LAST, t.priority ASC, t.created_at DESC`,
        [req.user.id]
      ),
    ]);
    res.json({ lists: lists.rows, todos: todos.rows, today: todayInAppZone(), timezone: APP_TIMEZONE });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/insights — completions per day for the last 7 days + streak
router.get('/insights', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT d::text AS day, COUNT(*)::int AS count FROM (
         SELECT (done_at AT TIME ZONE $2)::date AS d FROM todos
           WHERE done_by = $1 AND done_at > NOW() - INTERVAL '90 days'
         UNION ALL
         SELECT (completed_at AT TIME ZONE $2)::date FROM tasks
           WHERE completed_by = $1 AND status = 'completed' AND completed_at > NOW() - INTERVAL '90 days'
       ) x GROUP BY d`,
      [req.user.id, APP_TIMEZONE]
    );
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
    res.json({ week, streak, today_count: byDay.get(today) || 0, today });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos — { title, notes?, due_date?, due_time?, priority?, list_id?, recurrence?, mention_ids? }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const title = sanitizeText(req.body.title, 500);
    if (!title) return res.status(400).json({ error: 'What needs to be done?' });
    const notes = sanitizeText(req.body.notes, 5000);
    const listId = parseInt(req.body.list_id) || null;
    if (!(await ownsList(listId, req.user.id))) return res.status(404).json({ error: 'List not found' });
    const recurrence = RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null;
    const dueDate = parseDate(req.body.due_date) || (recurrence ? todayInAppZone() : null);

    const inserted = await db.query(
      `INSERT INTO todos (created_by, title, notes, due_date, due_time, priority, recurrence)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, title`,
      [req.user.id, title, notes || '', dueDate, parseTime(req.body.due_time), parsePriority(req.body.priority), recurrence]
    );
    const todo = inserted.rows[0];
    await db.query(
      'INSERT INTO todo_members (todo_id, user_id, list_id, added_by) VALUES ($1, $2, $3, $2)',
      [todo.id, req.user.id, listId]
    );

    const actor = await currentUser(req.user.id);
    await addMentionedMembers(todo, `${title} ${notes || ''}`, req.body.mention_ids, actor);

    broadcast(await memberIds(todo.id), todo.id, 'created');
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

// PUT /api/todos/:id — edit (any member); list_id only moves it in *my* list
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
    const scheduleChanged = dueDate !== existing.due_date || dueTime !== existing.due_time;

    await db.query(
      `UPDATE todos SET title = $1, notes = $2, due_date = $3, due_time = $4, priority = $5, recurrence = $6,
         reminded_at = CASE WHEN $7 THEN NULL ELSE reminded_at END
       WHERE id = $8`,
      [title, notes || '', dueDate, dueTime, priority, recurrence, scheduleChanged, existing.id]
    );

    if (req.body.list_id !== undefined) {
      const listId = parseInt(req.body.list_id) || null;
      if (!(await ownsList(listId, req.user.id))) return res.status(404).json({ error: 'List not found' });
      await db.query('UPDATE todo_members SET list_id = $1 WHERE todo_id = $2 AND user_id = $3', [listId, existing.id, req.user.id]);
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
router.post('/:id/toggle', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });

    const actor = await currentUser(req.user.id);
    let rolledTo = null;

    if (!existing.is_done && existing.recurrence) {
      rolledTo = nextOccurrence(existing.due_date || todayInAppZone(), existing.recurrence, todayInAppZone());
      await db.query(
        `UPDATE todos SET due_date = $1, reminded_at = NULL, done_at = NOW(), done_by = $2 WHERE id = $3`,
        [rolledTo, req.user.id, existing.id]
      );
    } else if (!existing.is_done) {
      await db.query('UPDATE todos SET is_done = TRUE, done_at = NOW(), done_by = $1 WHERE id = $2', [req.user.id, existing.id]);
    } else {
      await db.query('UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL WHERE id = $1', [existing.id]);
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

// DELETE /api/todos/:id — creator deletes for everyone; others just leave it
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await getTodoFor(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'To-do not found' });
    const members = await memberIds(existing.id);

    if (existing.created_by === req.user.id) {
      await db.query('DELETE FROM todos WHERE id = $1', [existing.id]);
      broadcast(members, existing.id, 'deleted');
      return res.json({ deleted: true });
    }
    await db.query('DELETE FROM todo_members WHERE todo_id = $1 AND user_id = $2', [existing.id, req.user.id]);
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
    await db.query('DELETE FROM todo_members WHERE todo_id = $1 AND user_id = $2', [existing.id, targetId]);
    broadcast(members, existing.id);
    res.json({ todo: await getTodoFor(existing.id, req.user.id) });
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

module.exports = router;
