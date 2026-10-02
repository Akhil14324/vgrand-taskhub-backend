const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { getTodoFor, listTodos, memberIds, audienceIds } = require('../services/todoQueries');
const { buildSegments } = require('../utils/segments');
const { todayInAppZone } = require('../utils/recurrence');
const { isAssignable } = require('../services/todoGovernance');
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

async function broadcast(todoId, action = 'updated') {
  emitToUsers(await audienceIds(todoId), 'todo:changed', { todoId: Number(todoId), action });
}

/** Load the to-do for the caller (they must be able to see it) or answer 404. */
async function openTodoFor(req, res) {
  const actor = await loadActor(req.user.id);
  const todo = actor ? await getTodoFor(req.params.id, actor.id, actor) : null;
  if (!todo) {
    res.status(404).json({ error: 'To-do not found' });
    return null;
  }
  req.actor = actor;
  return todo;
}

/** Work-in-progress changes need the right to work on it; proposals are not workable until accepted. */
function refuseUnlessWorkable(res, todo) {
  if (todo.review_state !== 'accepted') {
    res.status(400).json({ error: 'This is still waiting for review' });
    return true;
  }
  if (!todo.permissions.can_change_status) {
    res.status(403).json({ error: 'You cannot update this one' });
    return true;
  }
  return false;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// GET /api/todos/gantt?business_id=&scope=mine&assignee_id=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Everything the timeline chart needs: one row per to-do that overlaps the window, with the stretches
// during which it sat in one status with one person. Visibility follows the usual rules.
router.get('/gantt', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor) return res.status(401).json({ error: 'User no longer exists' });
    const businessId = parseInt(req.query.business_id, 10) || null;
    const assigneeId = parseInt(req.query.assignee_id, 10) || null;
    const ymd = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback);
    const today = todayInAppZone();
    const shift = (d, n) => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
    };
    const from = ymd(req.query.from, shift(today, -14));
    const to = ymd(req.query.to, shift(today, 21));

    const params = [from, `${to}T23:59:59Z`];
    const where = [
      `t.created_at <= $6::timestamptz`,
      `(t.done_at IS NULL OR t.done_at >= $5::date)`,
      `t.review_state <> 'rejected'`,
    ];
    if (businessId) {
      params.push(businessId);
      where.push(`t.business_id = $${params.length + 4}`);
    }
    if (assigneeId) {
      params.push(assigneeId);
      where.push(`t.assignee_id = $${params.length + 4}`);
    }
    const mine = !businessId && req.query.scope !== 'all';
    if (mine) where.push('(t.assignee_id = $1 OR t.created_by = $1)');

    const rows = await listTodos(actor.id, {
      actor,
      listOnly: mine,
      where: where.join(' AND '),
      params,
      tail: 'ORDER BY t.assignee_id NULLS LAST, t.created_at LIMIT 400',
    });
    const ids = rows.map((r) => r.id);
    const events = ids.length
      ? (await db.query(
        `SELECT todo_id, kind, created_at, from_value, to_value, meta, subject_id
         FROM todo_events WHERE todo_id = ANY($1::int[]) ORDER BY created_at, id`,
        [ids]
      )).rows
      : [];
    const byTodo = new Map();
    for (const e of events) {
      if (!byTodo.has(e.todo_id)) byTodo.set(e.todo_id, []);
      byTodo.get(e.todo_id).push(e);
    }

    const now = Date.now();
    const peopleIds = new Set();
    const items = rows.map((t) => {
      const built = buildSegments(t, byTodo.get(t.id) || [], now);
      built.segments.forEach((s) => s.assignee_id && peopleIds.add(s.assignee_id));
      built.handoffs.forEach((h) => { if (h.from) peopleIds.add(h.from); if (h.to) peopleIds.add(h.to); });
      if (t.assignee_id) peopleIds.add(t.assignee_id);
      return {
        id: t.id,
        title: t.title,
        parent_id: t.parent_id,
        business_id: t.business_id,
        business_name: t.business_name,
        priority: t.priority,
        status: t.status,
        is_done: t.is_done,
        review_state: t.review_state,
        assignee_id: t.assignee_id,
        created_at: t.created_at,
        started_at: t.started_at,
        due_at: t.due_at,
        due_date: t.due_date,
        done_at: t.done_at,
        start: iso(built.start),
        end: iso(built.end),
        running: !t.is_done,
        segments: built.segments.map((s) => ({ status: s.status, assignee_id: s.assignee_id, from: iso(s.from), to: iso(s.to) })),
        handoffs: built.handoffs.map((h) => ({ at: iso(h.at), from: h.from, to: h.to })),
      };
    });
    const people = peopleIds.size
      ? (await db.query(
        `SELECT id, name, username, profile_picture FROM users WHERE id = ANY($1::int[])`,
        [[...peopleIds]]
      )).rows
      : [];
    res.json({ from, to, today, items, people });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/:id/timeline — events + comments in time order, blockers, numbers and colour
router.get('/:id(\\d+)/timeline', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    res.json(await buildTimeline(todo));
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/status — { status: 'todo' | 'in_progress' | 'on_hold', note? }
// Done and in review go through /toggle, blocked through /blockers, so each keeps its own side effects.
router.post('/:id(\\d+)/status', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    const status = req.body.status;
    if (!['todo', 'in_progress', 'on_hold'].includes(status)) {
      return res.status(400).json({ error: 'Choose To do, In progress or On hold (use Blocker or the tick for the rest)' });
    }
    if (todo.review_state !== 'accepted') return res.status(400).json({ error: 'This is still waiting for review' });
    const holdChange = status === 'on_hold' || todo.status === 'on_hold';
    const allowed = holdChange
      ? todo.permissions.can_hold || todo.permissions.can_change_status
      : todo.permissions.can_change_status;
    if (!allowed) return res.status(403).json({ error: 'You cannot update this one' });
    if (todo.is_done) return res.status(400).json({ error: 'Reopen it first' });
    if (todo.status === 'blocked') return res.status(400).json({ error: 'Clear the blockers first' });
    if (todo.status === 'in_review') return res.status(400).json({ error: 'It is waiting for review' });

    const moved = await setStatus(todo.id, status);
    if (moved.changed) {
      await logEvent({
        todoId: todo.id, userId: req.actor.id, subjectId: todo.assignee_id, kind: 'status',
        from: moved.from, to: status, note: sanitizeText(req.body.note, 500) || null,
      });
    }
    await broadcast(todo.id);
    res.json({ todo: await getTodoFor(todo.id, req.actor.id, req.actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/assign — { user_id }: make someone accountable (they are added to it)
router.post('/:id(\\d+)/assign', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    if (!todo.permissions.can_assign) return res.status(403).json({ error: 'You cannot give this to someone else' });
    const userId = parseInt(req.body.user_id, 10);
    const target = userId
      ? (await db.query(`SELECT id FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0]
      : null;
    if (!target) return res.status(404).json({ error: 'Person not found' });
    if (todo.business_id && !(await isAssignable(userId, todo.business_id))) {
      return res.status(400).json({ error: 'That person is not part of this business' });
    }

    await assignTodo({ id: todo.id, title: todo.title }, userId, req.actor);
    await broadcast(todo.id);
    res.json({ todo: await getTodoFor(todo.id, req.actor.id, req.actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/updates — { note, progress? } a checkpoint: "what is the state right now?"
router.post('/:id(\\d+)/updates', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    if (refuseUnlessWorkable(res, todo)) return;
    const note = sanitizeText(req.body.note, 1000);
    if (!note) return res.status(400).json({ error: 'Write what changed' });
    const progress = req.body.progress === undefined || req.body.progress === null ? null : Number(req.body.progress);
    const meta = progress !== null && progress >= 0 && progress <= 100 ? { progress: Math.round(progress) } : null;

    // Posting an update means work has started.
    if (todo.status === 'todo' && !todo.is_done) {
      const moved = await setStatus(todo.id, 'in_progress');
      if (moved.changed) {
        await logEvent({ todoId: todo.id, userId: req.actor.id, subjectId: todo.assignee_id, kind: 'status', from: 'todo', to: 'in_progress' });
      }
    }
    await logEvent({ todoId: todo.id, userId: req.actor.id, subjectId: todo.assignee_id, kind: 'update', note, meta });

    const members = await memberIds(todo.id);
    await notify([...members, todo.created_by].filter(Boolean), {
      type: 'todo_update',
      title: `${req.actor.name} posted an update`,
      body: `${todo.title}: ${note.slice(0, 120)}`,
      data: { todoId: todo.id },
    }, { exclude: [req.actor.id] });
    await broadcast(todo.id);
    res.status(201).json({ todo: await getTodoFor(todo.id, req.actor.id, req.actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/blockers — { kind, note?, blocked_by_user_id?, blocked_by_todo_id? }
router.post('/:id(\\d+)/blockers', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    if (refuseUnlessWorkable(res, todo)) return;
    if (todo.is_done) return res.status(400).json({ error: 'It is already finished' });
    const kind = req.body.kind;
    if (!BLOCKER_KINDS.includes(kind)) return res.status(400).json({ error: 'Pick what is blocking it' });
    const note = sanitizeText(req.body.note, 1000);

    let blockedByTodo = null;
    if (kind === 'dependency') {
      const depId = parseInt(req.body.blocked_by_todo_id, 10);
      blockedByTodo = depId ? await getTodoFor(depId, req.actor.id, req.actor) : null;
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
      [todo.id, kind, note || '', blockedByUser ? blockedByUser.id : null, blockedByTodo ? blockedByTodo.id : null, req.actor.id]
    );

    const moved = await setStatus(todo.id, 'blocked');
    const detail = blockedByTodo ? blockedByTodo.title : blockedByUser ? blockedByUser.name : null;
    await logEvent({
      todoId: todo.id, userId: req.actor.id, subjectId: todo.assignee_id, kind: 'blocker_raised',
      to: BLOCKER_LABELS[kind], note: [detail, note].filter(Boolean).join(' — ') || null,
      meta: { blocker_id: inserted.rows[0].id, kind, blocked_by_user_id: blockedByUser?.id || null, blocked_by_todo_id: blockedByTodo?.id || null },
    });
    if (moved.changed) {
      await logEvent({ todoId: todo.id, userId: req.actor.id, subjectId: todo.assignee_id, kind: 'status', from: moved.from, to: 'blocked' });
    }

    await notifyMembers(todo.id, {
      type: 'todo_blocked',
      title: kind === 'dead_stop' ? `${req.actor.name} hit a dead stop` : `${req.actor.name} is blocked`,
      body: `${todo.title}${detail ? ` — ${detail}` : ''}${note ? `: ${note.slice(0, 100)}` : ''}`,
    }, [req.actor.id]);
    if (blockedByUser && blockedByUser.id !== req.actor.id) {
      await notify([blockedByUser.id], {
        type: 'todo_blocked',
        title: `${req.actor.name} is waiting on you`,
        body: `${todo.title}${note ? `: ${note.slice(0, 100)}` : ''}`,
        data: { todoId: todo.id },
      });
    }
    await broadcast(todo.id);
    res.status(201).json({ todo: await getTodoFor(todo.id, req.actor.id, req.actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/blockers/:blockerId/resolve — { note? }
router.post('/blockers/:blockerId(\\d+)/resolve', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const found = await db.query(
      `SELECT b.id, b.todo_id, b.kind, b.resolved_at, t.title, t.assignee_id
       FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
       WHERE b.id = $1`,
      [req.params.blockerId]
    );
    const blocker = found.rows[0];
    const todo = blocker ? await getTodoFor(blocker.todo_id, actor.id, actor) : null;
    if (!blocker || !todo) return res.status(404).json({ error: 'Blocker not found' });
    // The person blocking it can always say so; otherwise it takes the right to work on the to-do.
    if (!todo.permissions.can_change_status && !todo.permissions.can_edit) {
      return res.status(403).json({ error: 'You cannot update this one' });
    }
    if (blocker.resolved_at) return res.status(400).json({ error: 'Already cleared' });

    const note = sanitizeText(req.body.note, 500) || null;
    await db.query(
      'UPDATE todo_blockers SET resolved_at = NOW(), resolved_by = $2, resolution_note = $3 WHERE id = $1',
      [blocker.id, actor.id, note]
    );
    await logEvent({
      todoId: blocker.todo_id, userId: actor.id, subjectId: blocker.assignee_id, kind: 'blocker_cleared',
      to: BLOCKER_LABELS[blocker.kind], note, meta: { blocker_id: blocker.id },
    });
    const restored = await restoreAfterBlockers(blocker.todo_id, actor.id, blocker.assignee_id);

    if (restored) {
      await notifyMembers(blocker.todo_id, {
        type: 'todo_unblocked',
        title: `${actor.name} cleared a blocker`,
        body: blocker.title,
      }, [actor.id]);
    }
    await broadcast(blocker.todo_id);
    res.json({ todo: await getTodoFor(blocker.todo_id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
