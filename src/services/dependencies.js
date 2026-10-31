const db = require('../db');
const { logEvent } = require('./todoTimeline');
const { emitToUsers } = require('../utils/notify');
const { audienceIds } = require('./todoQueries');

/**
 * Task dependencies ("Dependent on", migration 059). A task waits for other tasks on the same board; when one
 * of them moves, everything that waits for it moves by the same number of days, all the way down the chain.
 * Dates are 'YYYY-MM-DD' strings (the DATE type parser is off), so day arithmetic is done in SQL.
 */

/** Every task (any depth) that waits for `id`, nearest first. Cycles cannot form (setDependencies refuses them). */
async function dependentsOf(id) {
  const rows = (await db.query(
    `WITH RECURSIVE chain AS (
       SELECT todo_id, 1 AS depth FROM todo_dependencies WHERE depends_on_id = $1
       UNION
       SELECT d.todo_id, c.depth + 1 FROM todo_dependencies d JOIN chain c ON d.depends_on_id = c.todo_id WHERE c.depth < 25
     ) SELECT todo_id, MIN(depth) AS depth FROM chain GROUP BY todo_id ORDER BY MIN(depth)`,
    [id]
  )).rows;
  return rows.map((r) => r.todo_id);
}

/** Days from `a` to `b` (both 'YYYY-MM-DD'). */
async function daysBetween(a, b) {
  return (await db.query('SELECT ($2::date - $1::date) AS n', [a, b])).rows[0].n;
}

/** Move the dates of these tasks by `days` (start, due and deadline together). Done tasks stay where they are. */
async function shiftTasks(ids, days, actorId, reason) {
  if (!ids.length || !days) return [];
  const moved = (await db.query(
    `UPDATE todos SET
       due_date = due_date + $2::int,
       start_date = start_date + $2::int,
       deadline_date = deadline_date + $2::int,
       reminded_at = NULL, reminders_sent = '{}'
     WHERE id = ANY($1::int[]) AND NOT is_done AND (due_date IS NOT NULL OR start_date IS NOT NULL)
     RETURNING id, assignee_id, due_date`,
    [ids, days]
  )).rows;
  for (const t of moved) {
    await logEvent({
      todoId: t.id, userId: actorId, subjectId: t.assignee_id, kind: 'due_changed',
      to: t.due_date, note: `${reason} (${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'})`,
    });
    emitToUsers(await audienceIds(t.id), 'todo:changed', { todoId: t.id, action: 'rescheduled' });
  }
  return moved.map((t) => t.id);
}

/** A task's due date moved from `from` to `to`: the tasks that wait for it move with it. */
async function followDueChange(todo, from, to, actorId) {
  if (!from || !to || from === to) return [];
  const ids = await dependentsOf(todo.id);
  if (!ids.length) return [];
  const days = await daysBetween(from, to);
  return shiftTasks(ids, days, actorId, `Moved with "${todo.title}"`);
}

/**
 * Replace what a task waits for. Same board only, never itself, never a loop. A task that would start
 * before what it waits for ends is moved to the day after (keeping its length).
 * Returns { ok, error?, moved }.
 */
async function setDependencies(todo, ids, actorId) {
  const wanted = [...new Set((ids || []).map((x) => parseInt(x, 10)).filter(Boolean))];
  if (wanted.includes(todo.id)) return { ok: false, error: 'A task cannot wait for itself' };
  if (wanted.length) {
    const found = (await db.query(
      'SELECT id, due_date FROM todos WHERE id = ANY($1::int[]) AND board_id IS NOT DISTINCT FROM $2', [wanted, todo.board_id]
    )).rows;
    if (found.length !== wanted.length) return { ok: false, error: 'Pick tasks from this board' };
    // A loop: one of the picks (or anything it waits for) already waits for this task.
    const below = new Set(await dependentsOf(todo.id));
    if (wanted.some((w) => below.has(w))) return { ok: false, error: 'That would make a loop: it already waits for this task' };
  }
  await db.query('DELETE FROM todo_dependencies WHERE todo_id = $1', [todo.id]);
  for (const w of wanted) {
    await db.query('INSERT INTO todo_dependencies (todo_id, depends_on_id, created_by) VALUES ($1, $2, $3)', [todo.id, w, actorId]);
  }
  let moved = [];
  if (wanted.length) {
    const latest = (await db.query('SELECT MAX(due_date) AS d FROM todos WHERE id = ANY($1::int[])', [wanted])).rows[0].d;
    const current = (await db.query('SELECT due_date, start_date FROM todos WHERE id = $1', [todo.id])).rows[0];
    const begins = current.start_date || current.due_date;
    if (latest && begins) {
      const gap = await daysBetween(begins, latest); // > -1 means it starts on or before the day its predecessor ends
      if (gap >= 0) {
        const days = gap + 1;
        moved = await shiftTasks([todo.id, ...(await dependentsOf(todo.id))], days, actorId, 'Moved after what it waits for');
      }
    }
  }
  await logEvent({
    todoId: todo.id, userId: actorId, subjectId: todo.assignee_id, kind: 'edited',
    note: wanted.length ? 'Dependent on changed' : 'Dependent on cleared', meta: { depends_on: wanted },
  });
  return { ok: true, moved };
}

module.exports = { dependentsOf, followDueChange, setDependencies };
