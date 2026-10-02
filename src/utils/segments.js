/**
 * Rebuild "who held this, in which status, for how long" from a to-do's event log, for the
 * Gantt-style timeline. Pure (no database), unit-tested in segments.test.js.
 *
 * A segment is one stretch of time during which both the status and the person doing the work stayed
 * the same: { status, assignee_id, from, to }. `to` is null for the stretch that is still running.
 * Statuses: todo, in_progress, blocked, in_review, on_hold, done (done is never a segment: it ends the bar).
 */

const toMs = (v) => (v == null ? null : new Date(v).getTime());

/** The status a log entry moves the to-do into, or null when it does not change the status. */
function statusAfter(event) {
  switch (event.kind) {
    case 'status': return event.to_value || null;
    case 'submitted': return 'in_review';
    case 'changes_requested': return 'in_progress';
    case 'reopened': return event.to_value || 'todo';
    case 'completed': return event.meta?.recurring ? 'todo' : 'done';
    default: return null;
  }
}

/**
 * @param todo   { created_at, created_by, assignee_id, is_done, done_at, status }
 * @param events oldest first: { kind, created_at, from_value, to_value, meta }
 * @param now    ms timestamp used as the end of a running stretch
 * @returns { segments, start, end, handoffs }
 */
function buildSegments(todo, events, now = Date.now()) {
  const start = toMs(todo.created_at);
  const created = events.find((e) => e.kind === 'created');
  let status = 'todo';
  let assignee = created?.subject_id ?? created?.meta?.assignee_id ?? todo.assignee_id ?? todo.created_by ?? null;
  let cursor = start;
  const segments = [];
  const handoffs = [];

  const close = (at) => {
    if (at > cursor) segments.push({ status, assignee_id: assignee, from: cursor, to: at });
    cursor = Math.max(cursor, at);
  };

  for (const event of events) {
    const at = toMs(event.created_at);
    if (event.kind === 'created') continue;
    if (event.kind === 'assigned') {
      const next = event.meta?.to_id ?? null;
      if (next !== assignee) {
        close(at);
        handoffs.push({ at, from: assignee, to: next });
        assignee = next;
      }
      continue;
    }
    const next = statusAfter(event);
    if (!next || next === status) continue;
    close(at);
    if (next === 'done') {
      return { segments, start, end: at, handoffs };
    }
    status = next;
  }

  if (todo.is_done && todo.done_at) {
    const end = toMs(todo.done_at);
    close(end);
    return { segments, start, end, handoffs };
  }
  // Still running: the last stretch ends "now" but stays open so the chart can keep it growing.
  const end = Math.max(now, cursor);
  if (end > cursor) segments.push({ status, assignee_id: assignee, from: cursor, to: null });
  return { segments, start, end, handoffs };
}

module.exports = { buildSegments, statusAfter };
