const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { getTodoFor, memberIds } = require('../services/todoQueries');
const {
  BLOCKER_KINDS,
  BLOCKER_LABELS,
  logEvent,
  setStatus,
  restoreAfterBlockers,
  buildTimeline,
  notifyMembers,
  assignTodo,
} = require('../services/todoTimeline');

// Mounted next to the to-do router on /api/todos.
const router = express.Router();

async function currentUser(userId) {
  return (await db.query('SELECT id, name, username FROM users WHERE id = $1', [userId])).rows[0];
}

function broadcast(userIds, todoId, action = 'updated') {
  emitToUsers(userIds, 'todo:changed', { todoId: Number(todoId), action });
}

/** Load the to-do for the caller (must be on it) and refuse finished ones. */
async function openTodoFor(req, res) {
  const todo = await getTodoFor(req.params.id, req.user.id);
  if (!todo) {
    res.status(404).json({ error: 'To-do not found' });
    return null;
  }
  return todo;
}

// GET /api/todos/:id/timeline — events + comments in time order, blockers, numbers and colour
router.get('/:id/timeline', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    res.json(await buildTimeline(todo));
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/status — { status: 'todo' | 'in_progress', note? }
// Done goes through /toggle and blocked through /blockers, so each keeps its own side effects.
router.post('/:id/status', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    const status = req.body.status;
    if (!['todo', 'in_progress'].includes(status)) {
      return res.status(400).json({ error: 'Choose To do or In progress (use Blocker or the tick for the rest)' });
    }
    if (todo.is_done) return res.status(400).json({ error: 'Reopen it first' });
    if (todo.status === 'blocked') return res.status(400).json({ error: 'Clear the blockers first' });

    const moved = await setStatus(todo.id, status);
    if (moved.changed) {
      await logEvent({
        todoId: todo.id, userId: req.user.id, subjectId: todo.assignee_id, kind: 'status',
        from: moved.from, to: status, note: sanitizeText(req.body.note, 500) || null,
      });
    }
    broadcast(await memberIds(todo.id), todo.id);
    res.json({ todo: await getTodoFor(todo.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/assign — { user_id }: make someone accountable (they are added to the to-do)
router.post('/:id/assign', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    const userId = parseInt(req.body.user_id, 10);
    const target = userId
      ? (await db.query(`SELECT id FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0]
      : null;
    if (!target) return res.status(404).json({ error: 'Person not found' });
    if (todo.parent_id) return res.status(400).json({ error: 'Assign the main to-do; sub-tasks follow it' });

    const actor = await currentUser(req.user.id);
    await assignTodo({ id: todo.id, title: todo.title }, userId, actor);
    broadcast(await memberIds(todo.id), todo.id);
    res.json({ todo: await getTodoFor(todo.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/updates — { note, progress? } a checkpoint: "what is the state right now?"
router.post('/:id/updates', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    const note = sanitizeText(req.body.note, 1000);
    if (!note) return res.status(400).json({ error: 'Write what changed' });
    const progress = req.body.progress === undefined || req.body.progress === null ? null : Number(req.body.progress);
    const meta = progress !== null && progress >= 0 && progress <= 100 ? { progress: Math.round(progress) } : null;

    // Posting an update means work has started.
    if (todo.status === 'todo' && !todo.is_done) {
      const moved = await setStatus(todo.id, 'in_progress');
      if (moved.changed) {
        await logEvent({ todoId: todo.id, userId: req.user.id, subjectId: todo.assignee_id, kind: 'status', from: 'todo', to: 'in_progress' });
      }
    }
    await logEvent({ todoId: todo.id, userId: req.user.id, subjectId: todo.assignee_id, kind: 'update', note, meta });

    const members = await memberIds(todo.id);
    const actor = await currentUser(req.user.id);
    await notify(members, {
      type: 'todo_update',
      title: `📝 ${actor.name} posted an update`,
      body: `${todo.title}: ${note.slice(0, 120)}`,
      data: { todoId: todo.id },
    }, { exclude: [req.user.id] });
    broadcast(members, todo.id);
    res.status(201).json({ todo: await getTodoFor(todo.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/blockers — { kind, note?, blocked_by_user_id?, blocked_by_todo_id? }
router.post('/:id/blockers', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    if (todo.is_done) return res.status(400).json({ error: 'It is already finished' });
    const kind = req.body.kind;
    if (!BLOCKER_KINDS.includes(kind)) return res.status(400).json({ error: 'Pick what is blocking it' });
    const note = sanitizeText(req.body.note, 1000);

    let blockedByTodo = null;
    if (kind === 'dependency') {
      const depId = parseInt(req.body.blocked_by_todo_id, 10);
      blockedByTodo = depId ? await getTodoFor(depId, req.user.id) : null;
      if (!blockedByTodo) return res.status(400).json({ error: 'Pick the to-do it is waiting on' });
      if (blockedByTodo.id === todo.id) return res.status(400).json({ error: 'A to-do cannot wait on itself' });
      if (blockedByTodo.is_done) return res.status(400).json({ error: 'That to-do is already finished' });
    }
    let blockedByUser = null;
    if (kind === 'waiting_on') {
      const userId = parseInt(req.body.blocked_by_user_id, 10);
      blockedByUser = userId
        ? (await db.query(`SELECT id, name FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0]
        : null;
      if (!blockedByUser && !note) return res.status(400).json({ error: 'Say who or what it is waiting on' });
    }
    if (kind !== 'dependency' && kind !== 'waiting_on' && !note) {
      return res.status(400).json({ error: 'Describe the problem so others can help' });
    }

    const inserted = await db.query(
      `INSERT INTO todo_blockers (todo_id, kind, note, blocked_by_user_id, blocked_by_todo_id, raised_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [todo.id, kind, note || '', blockedByUser ? blockedByUser.id : null, blockedByTodo ? blockedByTodo.id : null, req.user.id]
    );

    const moved = await setStatus(todo.id, 'blocked');
    const detail = blockedByTodo ? blockedByTodo.title : blockedByUser ? blockedByUser.name : null;
    await logEvent({
      todoId: todo.id, userId: req.user.id, subjectId: todo.assignee_id, kind: 'blocker_raised',
      to: BLOCKER_LABELS[kind], note: [detail, note].filter(Boolean).join(' — ') || null,
      meta: { blocker_id: inserted.rows[0].id, kind, blocked_by_user_id: blockedByUser?.id || null, blocked_by_todo_id: blockedByTodo?.id || null },
    });
    if (moved.changed) {
      await logEvent({ todoId: todo.id, userId: req.user.id, subjectId: todo.assignee_id, kind: 'status', from: moved.from, to: 'blocked' });
    }

    const actor = await currentUser(req.user.id);
    await notifyMembers(todo.id, {
      type: 'todo_blocked',
      title: kind === 'dead_stop' ? `🛑 ${actor.name} hit a dead stop` : `⛔ ${actor.name} is blocked`,
      body: `${todo.title}${detail ? ` — ${detail}` : ''}${note ? `: ${note.slice(0, 100)}` : ''}`,
    }, [req.user.id]);
    if (blockedByUser && blockedByUser.id !== req.user.id) {
      await notify([blockedByUser.id], {
        type: 'todo_blocked',
        title: `⏳ ${actor.name} is waiting on you`,
        body: `${todo.title}${note ? `: ${note.slice(0, 100)}` : ''}`,
        data: { todoId: todo.id },
      });
    }
    broadcast(await memberIds(todo.id), todo.id);
    res.status(201).json({ todo: await getTodoFor(todo.id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/blockers/:blockerId/resolve — { note? }
router.post('/blockers/:blockerId/resolve', authenticate, async (req, res, next) => {
  try {
    const found = await db.query(
      `SELECT b.id, b.todo_id, b.kind, b.resolved_at, t.title, t.assignee_id
       FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
       JOIN todo_members tm ON tm.todo_id = t.id AND tm.user_id = $2
       WHERE b.id = $1`,
      [req.params.blockerId, req.user.id]
    );
    const blocker = found.rows[0];
    if (!blocker) return res.status(404).json({ error: 'Blocker not found' });
    if (blocker.resolved_at) return res.status(400).json({ error: 'Already cleared' });

    const note = sanitizeText(req.body.note, 500) || null;
    await db.query(
      'UPDATE todo_blockers SET resolved_at = NOW(), resolved_by = $2, resolution_note = $3 WHERE id = $1',
      [blocker.id, req.user.id, note]
    );
    await logEvent({
      todoId: blocker.todo_id, userId: req.user.id, subjectId: blocker.assignee_id, kind: 'blocker_cleared',
      to: BLOCKER_LABELS[blocker.kind], note, meta: { blocker_id: blocker.id },
    });
    const restored = await restoreAfterBlockers(blocker.todo_id, req.user.id, blocker.assignee_id);

    const actor = await currentUser(req.user.id);
    if (restored) {
      await notifyMembers(blocker.todo_id, {
        type: 'todo_unblocked',
        title: `✅ ${actor.name} cleared a blocker`,
        body: blocker.title,
      }, [req.user.id]);
    }
    broadcast(await memberIds(blocker.todo_id), blocker.todo_id);
    res.json({ todo: await getTodoFor(blocker.todo_id, req.user.id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
