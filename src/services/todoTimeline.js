const db = require('../db');
const { notify } = require('../utils/notify');
const { computeMetrics, todoHealth } = require('../utils/timeline');
const { memberIds } = require('./todoQueries');

const BLOCKER_KINDS = ['dependency', 'waiting_on', 'issue', 'dead_stop'];
const BLOCKER_LABELS = {
  dependency: 'Waiting on another to-do',
  waiting_on: 'Waiting on someone',
  issue: 'Issue',
  dead_stop: 'Dead stop',
};

/** Append one entry to the event log. */
async function logEvent({ todoId, userId, subjectId, kind, from = null, to = null, note = null, meta = null }) {
  await db.query(
    `INSERT INTO todo_events (todo_id, user_id, subject_id, kind, from_value, to_value, note, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [todoId || null, userId || null, subjectId || null, kind, from, to, note, meta ? JSON.stringify(meta) : null]
  );
}

/**
 * Move a to-do to a new status, banking the seconds spent in the previous one.
 * Returns { changed, from } — a no-op (same status) returns changed: false.
 */
async function setStatus(todoId, newStatus) {
  const current = await db.query('SELECT status FROM todos WHERE id = $1', [todoId]);
  const from = current.rows[0]?.status;
  if (!from || from === newStatus) return { changed: false, from };
  await db.query(
    `UPDATE todos SET
       status_seconds = CASE WHEN status = 'done' THEN status_seconds
         ELSE jsonb_set(status_seconds, ARRAY[status::text],
              to_jsonb(COALESCE((status_seconds->>status)::numeric, 0)
                       + EXTRACT(EPOCH FROM (NOW() - status_since))::bigint)) END,
       status = $2::text,
       status_since = NOW(),
       started_at = CASE WHEN $2::text = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END
     WHERE id = $1`,
    [todoId, newStatus]
  );
  return { changed: true, from };
}

/** Clear all open blockers of a to-do. Returns the rows that were cleared. */
async function resolveOpenBlockers(todoId, actorId, note) {
  const result = await db.query(
    `UPDATE todo_blockers SET resolved_at = NOW(), resolved_by = $2, resolution_note = $3
     WHERE todo_id = $1 AND resolved_at IS NULL RETURNING id, kind`,
    [todoId, actorId, note || null]
  );
  return result.rows;
}

/** When the last blocker is gone, a blocked to-do goes back to work (or back to the queue). */
async function restoreAfterBlockers(todoId, actorId, subjectId) {
  const row = (await db.query(
    `SELECT status, started_at,
            (SELECT COUNT(*)::int FROM todo_blockers b WHERE b.todo_id = $1 AND b.resolved_at IS NULL) AS open
     FROM todos WHERE id = $1`,
    [todoId]
  )).rows[0];
  if (!row || row.status !== 'blocked' || row.open > 0) return false;
  const target = row.started_at ? 'in_progress' : 'todo';
  const moved = await setStatus(todoId, target);
  if (moved.changed) {
    await logEvent({ todoId, userId: actorId, subjectId, kind: 'status', from: 'blocked', to: target });
  }
  return true;
}

/**
 * Everything the timeline view shows for one to-do: the event log and comments merged in time
 * order, the blockers, the numbers and the colour. `todo` is a row from TODO_SELECT.
 */
async function buildTimeline(todo, now = Date.now()) {
  const [events, comments, blockers] = await Promise.all([
    db.query(
      `SELECT e.id, e.kind, e.user_id, u.name AS user_name, e.from_value, e.to_value, e.note, e.meta, e.created_at
       FROM todo_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.todo_id = $1 ORDER BY e.created_at, e.id`,
      [todo.id]
    ),
    db.query(
      `SELECT c.id, c.kind, c.user_id, u.name AS user_name, c.body AS note, c.created_at
       FROM todo_comments c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.todo_id = $1 ORDER BY c.created_at, c.id`,
      [todo.id]
    ),
    db.query(
      `SELECT b.id, b.kind, b.note, b.raised_at, b.resolved_at, b.resolution_note,
              b.blocked_by_user_id, bu.name AS blocked_by_user_name,
              b.blocked_by_todo_id, bt.title AS blocked_by_todo_title,
              b.raised_by, ru.name AS raised_by_name, b.resolved_by, vu.name AS resolved_by_name
       FROM todo_blockers b
       LEFT JOIN users bu ON bu.id = b.blocked_by_user_id
       LEFT JOIN todos bt ON bt.id = b.blocked_by_todo_id
       LEFT JOIN users ru ON ru.id = b.raised_by
       LEFT JOIN users vu ON vu.id = b.resolved_by
       WHERE b.todo_id = $1 ORDER BY b.raised_at`,
      [todo.id]
    ),
  ]);

  const entries = [
    ...events.rows.map((e) => ({ ...e, type: 'event' })),
    ...comments.rows.map((c) => ({ ...c, type: 'comment', kind: c.kind === 'question' ? 'question' : 'comment' })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const reschedules = events.rows.filter((e) => e.kind === 'due_changed' && e.from_value).length;
  return {
    entries,
    blockers: blockers.rows,
    metrics: { ...computeMetrics(todo, now), reschedules },
    health: todoHealth(todo, now),
  };
}

/**
 * Make someone the accountable assignee (adding them to the to-do and its sub-tasks if needed).
 * Restarts the response clock for the new person. Returns false when nothing changed.
 */
async function assignTodo(todo, userId, actor) {
  const cur = (await db.query('SELECT assignee_id, status FROM todos WHERE id = $1', [todo.id])).rows[0];
  if (!cur || cur.assignee_id === userId) return false;
  const names = await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[])', [[userId, cur.assignee_id].filter(Boolean)]);
  const nameOf = (id) => names.rows.find((u) => u.id === id)?.name || null;

  await db.query(
    `INSERT INTO todo_members (todo_id, user_id, list_id, added_by) VALUES ($1, $2, NULL, $3) ON CONFLICT DO NOTHING`,
    [todo.id, userId, actor.id]
  );
  await db.query(
    `INSERT INTO todo_members (todo_id, user_id, list_id, added_by)
     SELECT c.id, $2::int, NULL::int, $3::int FROM todos c WHERE c.parent_id = $1 ON CONFLICT DO NOTHING`,
    [todo.id, userId, actor.id]
  );
  await db.query('UPDATE todos SET assignee_id = $2, assigned_at = NOW(), started_at = NULL WHERE id = $1', [todo.id, userId]);
  await logEvent({
    todoId: todo.id, userId: actor.id, subjectId: userId, kind: 'assigned',
    from: nameOf(cur.assignee_id), to: nameOf(userId), meta: { from_id: cur.assignee_id, to_id: userId },
  });
  // New person, fresh start: work that was under way goes back to the queue.
  if (cur.status === 'in_progress') {
    await setStatus(todo.id, 'todo');
    await logEvent({ todoId: todo.id, userId: actor.id, subjectId: userId, kind: 'status', from: 'in_progress', to: 'todo', note: 'Reassigned' });
  }
  if (userId !== actor.id) {
    await notify([userId], {
      type: 'todo_assigned',
      title: `📌 ${actor.name} assigned you a to-do`,
      body: todo.title,
      data: { todoId: todo.id },
    });
  }
  return true;
}

/** A to-do was finished: free everything that was waiting on it. */
async function releaseDependents(todoId, actor) {
  const cleared = await db.query(
    `UPDATE todo_blockers SET resolved_at = NOW(), resolved_by = $2, resolution_note = 'Dependency finished'
     WHERE blocked_by_todo_id = $1 AND resolved_at IS NULL RETURNING id, todo_id`,
    [todoId, actor.id]
  );
  const waiting = [...new Set(cleared.rows.map((r) => r.todo_id))];
  for (const id of waiting) {
    const row = (await db.query('SELECT title, assignee_id FROM todos WHERE id = $1', [id])).rows[0];
    if (!row) continue;
    await logEvent({
      todoId: id, userId: actor.id, subjectId: row.assignee_id, kind: 'blocker_cleared',
      note: 'The to-do it was waiting on is finished', meta: { auto: true, blocked_by_todo_id: todoId },
    });
    await restoreAfterBlockers(id, actor.id, row.assignee_id);
    await notifyMembers(id, {
      type: 'todo_unblocked',
      title: '✅ Unblocked',
      body: row.title,
    }, [actor.id]);
  }
}

/** Tell people a to-do they share is blocked / unblocked. */
async function notifyMembers(todoId, payload, exclude = []) {
  const members = await memberIds(todoId);
  await notify(members, { ...payload, data: { todoId, ...(payload.data || {}) } }, { exclude });
}

module.exports = {
  BLOCKER_KINDS,
  BLOCKER_LABELS,
  logEvent,
  setStatus,
  resolveOpenBlockers,
  restoreAfterBlockers,
  buildTimeline,
  notifyMembers,
  assignTodo,
  releaseDependents,
};
