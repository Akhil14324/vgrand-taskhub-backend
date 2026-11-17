/**
 * One task as a process: where its time went. Built from the task, its event log, its steps (sub-tasks at any
 * depth), what it waits for and its blockers. Pure (no database), unit-tested in process.test.js.
 * All durations are in seconds.
 */
const { computeMetrics } = require('./timeline');
const { buildSegments } = require('./segments');

const toMs = (v) => (v == null ? null : new Date(v).getTime());
const secs = (a, b) => (a == null || b == null ? null : Math.max(0, Math.round((b - a) / 1000)));
const DAY = 86400000;

/** Steps in reading order (a step's own steps right under it), each with its depth and whether it is a leaf. */
function orderSteps(rootId, rows) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
    kids.get(r.parent_id).push(r);
  }
  for (const list of kids.values()) list.sort((a, b) => toMs(a.created_at) - toMs(b.created_at) || a.id - b.id);
  const out = [];
  const walk = (id, depth) => {
    for (const r of kids.get(id) || []) {
      out.push({ row: r, depth, leaf: !(kids.get(r.id) || []).length });
      if (depth < 8) walk(r.id, depth + 1);
    }
  };
  walk(rootId, 0);
  return out;
}

/**
 * @param todo      the task row (created_at, started_at, done_at, due_date, status, status_seconds, ...)
 * @param events    its log, oldest first
 * @param steps     every sub-task below it (id, parent_id and the same time fields)
 * @param waitsFor  tasks it depends on: { id, title, is_done, done_at, due_date, assignee_name, linked_at }
 * @param neededBy  tasks that depend on it: { id, title, is_done, due_date, assignee_name }
 * @param blockers  { kind, note, raised_at, resolved_at, blocked_by_user_name, blocked_by_todo_title }
 * @param nameOf    user id -> name
 */
function buildProcess({ todo, events = [], steps = [], waitsFor = [], neededBy = [], blockers = [], nameOf = () => null }, now = Date.now()) {
  const metrics = computeMetrics(todo, now);
  const end = todo.is_done && todo.done_at ? toMs(todo.done_at) : now;
  const created = toMs(todo.created_at);

  // Days late: against the due date, at the finish for a finished task and today for an open one.
  let lateDays = null;
  if (todo.due_date) {
    const due = new Date(`${String(todo.due_date).slice(0, 10)}T23:59:59`).getTime();
    lateDays = end > due ? Math.ceil((end - due) / DAY) : 0;
  }

  const stages = ['todo', 'in_progress', 'blocked', 'in_review', 'on_hold']
    .map((status) => ({ status, seconds: metrics.status_s[status] || 0 }))
    .filter((s) => s.seconds > 0);

  const seg = buildSegments(todo, events, now);
  const held = new Map();
  for (const s of seg.segments) {
    const key = s.assignee_id ?? 0;
    held.set(key, (held.get(key) || 0) + secs(s.from, s.to ?? now));
  }
  const holders = [...held.entries()].map(([id, seconds]) => ({ id: id || null, name: id ? nameOf(id) || 'Someone' : 'Nobody yet', seconds }))
    .sort((a, b) => b.seconds - a.seconds);

  const list = orderSteps(todo.id, steps).map(({ row, depth, leaf }) => {
    const m = computeMetrics(row, now);
    const started = toMs(row.started_at);
    const done = row.is_done && row.done_at ? toMs(row.done_at) : null;
    const from = started ?? (done ? toMs(row.assigned_at) ?? toMs(row.created_at) : null);
    return {
      id: row.id, title: row.title, depth, leaf,
      assignee_name: row.assignee_name || null,
      status: row.is_done ? 'done' : row.status || 'todo', is_done: !!row.is_done,
      created_at: row.created_at, started_at: row.started_at || null, done_at: row.is_done ? row.done_at : null, due_date: row.due_date || null,
      // How long the step itself took (or has been running); null while it has not been started.
      took_s: from == null ? null : secs(from, done ?? now),
      // How long it sat before anyone started it.
      wait_s: secs(toMs(row.created_at), started ?? done ?? now),
      blocked_s: m.blocked_s || 0,
      estimate_s: m.estimate_s,
    };
  });
  const leaves = list.filter((s) => s.leaf);
  const stepSum = leaves.reduce((n, s) => n + (s.took_s || 0), 0);
  for (const s of list) s.share = s.leaf && stepSum ? Math.round(((s.took_s || 0) / stepSum) * 100) : null;
  const estimate = leaves.reduce((n, s) => n + (s.estimate_s || 0), 0) || metrics.estimate_s || null;
  const slowest = leaves.filter((s) => s.took_s).sort((a, b) => b.took_s - a.took_s)[0] || null;

  const waits = waitsFor.map((d) => {
    const doneAt = d.is_done && d.done_at ? toMs(d.done_at) : null;
    const from = Math.max(created, toMs(d.linked_at) ?? created);
    return {
      id: d.id, title: d.title, is_done: !!d.is_done, done_at: d.is_done ? d.done_at : null, due_date: d.due_date || null,
      assignee_name: d.assignee_name || null,
      // Time this task spent waiting for that one: from the link (or this task's start) until that one finished.
      waited_s: doneAt != null && doneAt <= from ? 0 : secs(from, Math.min(doneAt ?? end, end)),
    };
  });

  const count = (kind) => events.filter((e) => e.kind === kind).length;
  return {
    task: {
      id: todo.id, title: todo.title, status: todo.is_done ? 'done' : todo.status || 'todo', is_done: !!todo.is_done,
      created_at: todo.created_at, started_at: todo.started_at || null, done_at: todo.is_done ? todo.done_at : null,
      start_date: todo.start_date || null, due_date: todo.due_date || null,
      assignee_name: todo.assignee_name || null, creator_name: todo.created_by_name || nameOf(todo.created_by) || null,
    },
    numbers: {
      total_s: metrics.lead_s,
      working_s: metrics.active_s,
      before_start_s: metrics.response_s ?? (todo.started_at ? 0 : secs(toMs(todo.assigned_at) ?? created, end)),
      started: !!todo.started_at,
      blocked_s: metrics.blocked_s,
      review_s: metrics.status_s.in_review || 0,
      hold_s: metrics.status_s.on_hold || 0,
      waiting_on_others_s: waits.reduce((n, w) => Math.max(n, w.waited_s || 0), 0),
      estimate_s: estimate,
      steps_total: leaves.length, steps_done: leaves.filter((s) => s.is_done).length,
      steps_time_s: stepSum,
      late_days: lateDays,
      handoffs: seg.handoffs.length,
      reopened: count('reopened'),
      date_changes: count('due_changed'),
      blockers: blockers.length,
      slowest_step: slowest ? { id: slowest.id, title: slowest.title, took_s: slowest.took_s } : null,
    },
    stages, holders, steps: list,
    waits_for: waits,
    needed_by: neededBy.map((d) => ({ id: d.id, title: d.title, is_done: !!d.is_done, due_date: d.due_date || null, assignee_name: d.assignee_name || null })),
    blockers: blockers.map((b) => ({
      kind: b.kind, note: b.note || '', raised_at: b.raised_at, resolved_at: b.resolved_at || null,
      on: b.blocked_by_user_name || b.blocked_by_todo_title || null,
      seconds: secs(toMs(b.raised_at), toMs(b.resolved_at) ?? end),
    })),
  };
}

module.exports = { buildProcess, orderSteps };
