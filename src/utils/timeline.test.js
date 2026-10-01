const test = require('node:test');
const assert = require('node:assert/strict');
const {
  statusSeconds, computeMetrics, todoHealth, completionSnapshot, finishedOnTime, formatSeconds,
} = require('./timeline');

const T0 = Date.parse('2026-10-01T09:00:00Z');
const at = (hours) => new Date(T0 + hours * 3600 * 1000).toISOString();
const base = (over = {}) => ({
  title: 'x', created_by: 1, assignee_id: 1, is_done: false, status: 'todo', parent_id: null,
  created_at: at(0), assigned_at: at(0), started_at: null, done_at: null,
  status_since: at(0), status_seconds: {}, due_at: null, deadline_at: null, duration_minutes: null,
  ...over,
});

test('statusSeconds adds the span in progress now', () => {
  const s = statusSeconds(base({ status: 'in_progress', status_since: at(2), status_seconds: { todo: 7200 } }), T0 + 5 * 3600 * 1000);
  assert.deepEqual(s, { todo: 7200, in_progress: 3 * 3600, blocked: 0 });
});

test('statusSeconds stops counting once done', () => {
  const s = statusSeconds(base({ is_done: true, status: 'done', status_since: at(2), status_seconds: { in_progress: 100 } }), T0 + 99 * 3600 * 1000);
  assert.equal(s.in_progress, 100);
});

test('metrics: lead, response, cycle, blocked, active', () => {
  const todo = base({
    is_done: true, status: 'done', started_at: at(2), done_at: at(10),
    status_seconds: { todo: 2 * 3600, in_progress: 5 * 3600, blocked: 3 * 3600 },
  });
  const m = computeMetrics(todo);
  assert.equal(m.lead_s, 10 * 3600);
  assert.equal(m.response_s, 2 * 3600);
  assert.equal(m.cycle_s, 8 * 3600);
  assert.equal(m.blocked_s, 3 * 3600);
  assert.equal(m.active_s, 5 * 3600);
});

test('cycle falls back to assigned→done when never started', () => {
  const m = computeMetrics(base({ is_done: true, status: 'done', done_at: at(6) }));
  assert.equal(m.cycle_s, 6 * 3600);
  assert.equal(m.response_s, null);
});

test('open to-do: green early, orange late in the window, red once overdue', () => {
  const todo = base({ due_at: at(10) });
  assert.equal(todoHealth(todo, T0 + 2 * 3600e3).level, 'green');
  assert.equal(todoHealth(todo, T0 + 8 * 3600e3).level, 'orange'); // 80 % used
  assert.equal(todoHealth(todo, T0 + 9.5 * 3600e3).level, 'orange'); // under 2h left
  const late = todoHealth(todo, T0 + 11 * 3600e3);
  assert.equal(late.level, 'red');
  assert.ok(late.reasons.includes('Overdue'));
});

test('blocked: orange, red after a day', () => {
  const blocked = base({ status: 'blocked', status_since: at(1) });
  assert.equal(todoHealth(blocked, T0 + 5 * 3600e3).level, 'orange');
  assert.equal(todoHealth(blocked, T0 + 30 * 3600e3).level, 'red');
});

test('estimate: orange near it, red over it', () => {
  const todo = base({ status: 'in_progress', started_at: at(0), status_since: at(0), duration_minutes: 120 });
  assert.equal(todoHealth(todo, T0 + 1 * 3600e3).level, 'green');
  assert.equal(todoHealth(todo, T0 + 1.8 * 3600e3).level, 'orange');
  assert.equal(todoHealth(todo, T0 + 3 * 3600e3).level, 'red');
});

test('worst signal wins', () => {
  const todo = base({ status: 'blocked', status_since: at(0), due_at: at(100) });
  assert.equal(todoHealth(todo, T0 + 2 * 3600e3).level, 'orange');
});

test('nothing to judge by → none; stale untouched → orange then red', () => {
  assert.equal(todoHealth(base(), T0 + 3600e3).level, 'none');
  assert.equal(todoHealth(base(), T0 + 4 * 24 * 3600e3).level, 'orange');
  assert.equal(todoHealth(base(), T0 + 9 * 24 * 3600e3).level, 'red');
});

test('finished: on time green, a little late orange, very late red', () => {
  const done = (doneH) => base({ is_done: true, status: 'done', due_at: at(10), done_at: at(doneH) });
  assert.equal(todoHealth(done(9)).level, 'green');
  assert.equal(todoHealth(done(20)).level, 'orange');
  assert.equal(todoHealth(done(60)).level, 'red');
  assert.equal(finishedOnTime(done(9)), true);
  assert.equal(finishedOnTime(done(11)), false);
  assert.equal(finishedOnTime(base({ is_done: true, done_at: at(1) })), null);
});

test('finished over the estimate is flagged', () => {
  const todo = base({
    is_done: true, status: 'done', started_at: at(0), done_at: at(5), duration_minutes: 120,
  });
  assert.equal(todoHealth(todo).level, 'red'); // 5h against 2h
});

test('completionSnapshot carries what the monitor needs', () => {
  const now = T0 + 8 * 3600e3;
  const snap = completionSnapshot(base({
    title: 'Pay GST', started_at: at(1), due_at: at(12), duration_minutes: 60,
    status: 'in_progress', status_since: at(1), status_seconds: { todo: 3600, blocked: 1800 },
  }), now);
  assert.equal(snap.title, 'Pay GST');
  assert.equal(snap.assignee_id, 1);
  assert.equal(snap.on_time, true);
  assert.equal(snap.lead_s, 8 * 3600);
  assert.equal(snap.response_s, 3600);
  assert.equal(snap.estimate_min, 60);
  assert.equal(snap.blocked_s, 1800);
});

test('formatSeconds', () => {
  assert.equal(formatSeconds(30), '<1m');
  assert.equal(formatSeconds(45 * 60), '45m');
  assert.equal(formatSeconds(2 * 3600 + 15 * 60), '2h 15m');
  assert.equal(formatSeconds(3 * 86400 + 4 * 3600), '3d 4h');
  assert.equal(formatSeconds(null), '–');
});
