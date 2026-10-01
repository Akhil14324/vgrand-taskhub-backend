/**
 * Pure time maths for the to-do timeline: how long things took and whether they are on track.
 * No database access here, so it is unit-tested directly (timeline.test.js).
 *
 * The client keeps a mirror of todoHealth() in Taskhub-mobile/src/utils/timeline.js so rows can
 * recolour live as time passes; keep the two in step.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;

const LEVEL_RANK = { none: 0, green: 1, orange: 2, red: 3 };

const toMs = (v) => (v == null ? null : new Date(v).getTime());
const secs = (fromMs, toMsValue) => Math.max(0, Math.round((toMsValue - fromMs) / 1000));

/** Seconds spent in each of todo / in_progress / blocked, including the span in progress now. */
function statusSeconds(todo, now = Date.now()) {
  const acc = { todo: 0, in_progress: 0, blocked: 0, ...(todo.status_seconds || {}) };
  for (const key of Object.keys(acc)) acc[key] = Math.round(Number(acc[key]) || 0);
  if (!todo.is_done && acc[todo.status] !== undefined && todo.status_since) {
    acc[todo.status] += secs(toMs(todo.status_since), now);
  }
  return acc;
}

/**
 * Headline numbers for one to-do (all in seconds).
 *  lead     created → done (or → now while open)
 *  response assigned → first started
 *  cycle    started (or assigned, if never started) → done / now
 *  blocked  time spent blocked
 *  active   cycle − blocked
 */
function computeMetrics(todo, now = Date.now()) {
  const end = todo.is_done && todo.done_at ? toMs(todo.done_at) : now;
  const created = toMs(todo.created_at);
  const assigned = toMs(todo.assigned_at) ?? created;
  const started = toMs(todo.started_at);
  const st = statusSeconds(todo, now);
  const cycleStart = started ?? assigned;
  const cycle = secs(cycleStart, end);
  return {
    lead_s: secs(created, end),
    response_s: started ? secs(assigned, started) : null,
    cycle_s: cycle,
    blocked_s: st.blocked,
    active_s: Math.max(0, cycle - st.blocked),
    status_s: st,
    estimate_s: todo.duration_minutes ? todo.duration_minutes * 60 : null,
  };
}

/** true / false against the due time, or null when there is no due date. */
function finishedOnTime(todo) {
  if (!todo.due_at || !todo.done_at) return null;
  return toMs(todo.done_at) <= toMs(todo.due_at);
}

function worst(a, b) {
  return LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a;
}

/**
 * Is this to-do on track?  → { level: 'none' | 'green' | 'orange' | 'red', reasons: string[] }
 *
 * Open to-dos: overdue / most of the time budget gone / blocked for long / over the estimate /
 * left untouched for days. Finished ones: late or over the estimate. 'none' = nothing to judge by.
 */
function todoHealth(todo, now = Date.now()) {
  const reasons = [];
  let result = { level: 'none' };
  const mark = (level, reason) => {
    result = worst(result, { level });
    if (reason) reasons.push(reason);
  };
  const m = computeMetrics(todo, now);

  if (todo.is_done) {
    const doneAt = toMs(todo.done_at);
    if (todo.due_at && doneAt) {
      const lateBy = secs(toMs(todo.due_at), doneAt);
      if (doneAt <= toMs(todo.due_at)) mark('green', 'Finished on time');
      else if (lateBy <= DAY) mark('orange', 'Finished a little late');
      else mark('red', 'Finished late');
    }
    if (m.estimate_s) {
      const ratio = m.active_s / m.estimate_s;
      if (ratio > 1.5) mark('red', 'Took much longer than estimated');
      else if (ratio > 1) mark('orange', 'Took longer than estimated');
      else mark('green', 'Within the estimate');
    }
    return { level: result.level, reasons };
  }

  const dueAt = toMs(todo.due_at);
  const start = toMs(todo.assigned_at) ?? toMs(todo.created_at);
  if (dueAt) {
    if (now > dueAt) mark('red', 'Overdue');
    else {
      const total = dueAt - start;
      const elapsed = now - start;
      if (dueAt - now <= 2 * HOUR * 1000) mark('orange', 'Due within 2 hours');
      else if (total > 0 && elapsed / total >= 0.75) mark('orange', 'Most of the time is used up');
      else mark('green');
    }
  }

  const deadlineAt = toMs(todo.deadline_at);
  if (deadlineAt) {
    if (now > deadlineAt) mark('red', 'Deadline passed');
    else if (deadlineAt - now <= DAY * 1000) mark('orange', 'Deadline within a day');
    else mark('green');
  }

  if (todo.status === 'blocked') {
    if (m.status_s.blocked >= DAY) mark('red', 'Blocked for over a day');
    else mark('orange', 'Blocked');
  }

  if (m.estimate_s && todo.started_at) {
    const ratio = m.status_s.in_progress / m.estimate_s;
    if (ratio > 1) mark('red', 'Over the estimate');
    else if (ratio >= 0.8) mark('orange', 'Close to the estimate');
    else mark('green');
  }

  // Nothing else to go on: judge by how long it has sat untouched.
  if (!dueAt && !deadlineAt && todo.status === 'todo') {
    const age = secs(toMs(todo.assigned_at) ?? toMs(todo.created_at), now);
    if (age > 7 * DAY) mark('red', 'Untouched for over a week');
    else if (age > 3 * DAY) mark('orange', 'Untouched for days');
  }

  return { level: result.level, reasons };
}

/** Snapshot stored on the "completed" event so team metrics survive edits and deletes. */
function completionSnapshot(todo, now = Date.now()) {
  const m = computeMetrics({ ...todo, is_done: true, done_at: new Date(now).toISOString() }, now);
  return {
    title: todo.title,
    assignee_id: todo.assignee_id ?? todo.created_by,
    is_subtask: !!todo.parent_id,
    lead_s: m.lead_s,
    response_s: m.response_s,
    cycle_s: m.cycle_s,
    blocked_s: m.blocked_s,
    active_s: m.active_s,
    estimate_min: todo.duration_minutes || null,
    on_time: todo.due_at ? now <= toMs(todo.due_at) : null,
  };
}

/** "3d 4h", "2h 15m", "40m", "<1m" */
function formatSeconds(s) {
  if (s == null) return '–';
  const v = Math.round(s);
  if (v < 60) return '<1m';
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  const mnt = Math.floor((v % HOUR) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return mnt ? `${h}h ${mnt}m` : `${h}h`;
  return `${mnt}m`;
}

module.exports = {
  DAY,
  HOUR,
  LEVEL_RANK,
  statusSeconds,
  computeMetrics,
  finishedOnTime,
  todoHealth,
  completionSnapshot,
  formatSeconds,
};
