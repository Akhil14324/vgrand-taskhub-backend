const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSegments } = require('./segments');

const T0 = Date.parse('2026-10-01T09:00:00Z');
const at = (h) => new Date(T0 + h * 3600 * 1000).toISOString();
const todo = (over = {}) => ({ created_at: at(0), created_by: 1, assignee_id: 1, is_done: false, done_at: null, status: 'todo', ...over });
const ev = (kind, hours, extra = {}) => ({ kind, created_at: at(hours), from_value: null, to_value: null, meta: null, ...extra });

test('a to-do nobody touched is one open stretch from creation', () => {
  const r = buildSegments(todo(), [ev('created', 0, { subject_id: 1 })], T0 + 5 * 3600 * 1000);
  assert.deepEqual(r.segments, [{ status: 'todo', assignee_id: 1, from: T0, to: null }]);
  assert.equal(r.end, T0 + 5 * 3600 * 1000);
});

test('status changes split the bar and a hand-off changes who holds it', () => {
  const events = [
    ev('created', 0, { subject_id: 1 }),
    ev('assigned', 1, { meta: { from_id: 1, to_id: 2 } }),
    ev('status', 2, { from_value: 'todo', to_value: 'in_progress' }),
    ev('status', 4, { from_value: 'in_progress', to_value: 'blocked' }),
    ev('status', 5, { from_value: 'blocked', to_value: 'in_progress' }),
  ];
  const r = buildSegments(todo({ assignee_id: 2, status: 'in_progress' }), events, T0 + 8 * 3600 * 1000);
  assert.deepEqual(r.segments.map((s) => [s.status, s.assignee_id, (s.from - T0) / 3600000, s.to === null ? null : (s.to - T0) / 3600000]), [
    ['todo', 1, 0, 1],
    ['todo', 2, 1, 2],
    ['in_progress', 2, 2, 4],
    ['blocked', 2, 4, 5],
    ['in_progress', 2, 5, null],
  ]);
  assert.equal(r.handoffs.length, 1);
  assert.deepEqual([r.handoffs[0].from, r.handoffs[0].to], [1, 2]);
});

test('finishing ends the bar at the completion time', () => {
  const events = [
    ev('created', 0, { subject_id: 1 }),
    ev('status', 1, { to_value: 'in_progress' }),
    ev('completed', 3, { meta: {} }),
  ];
  const r = buildSegments(todo({ is_done: true, done_at: at(3) }), events, T0 + 99 * 3600 * 1000);
  assert.equal(r.end, T0 + 3 * 3600 * 1000);
  assert.deepEqual(r.segments.map((s) => s.status), ['todo', 'in_progress']);
  assert.ok(r.segments.every((s) => s.to !== null));
});

test('review: submitted goes to in_review, changes_requested back to in_progress', () => {
  const events = [
    ev('created', 0, { subject_id: 1 }),
    ev('status', 1, { to_value: 'in_progress' }),
    ev('submitted', 2, { from_value: 'in_progress', to_value: 'in_review' }),
    ev('changes_requested', 3, { from_value: 'in_review', to_value: 'in_progress' }),
    ev('submitted', 4, { from_value: 'in_progress', to_value: 'in_review' }),
    ev('completed', 5, { meta: {} }),
  ];
  const r = buildSegments(todo({ is_done: true, done_at: at(5) }), events);
  assert.deepEqual(r.segments.map((s) => s.status), ['todo', 'in_progress', 'in_review', 'in_progress', 'in_review']);
});

test('a reopened to-do continues after being done only when later events say so', () => {
  const events = [ev('created', 0, { subject_id: 1 }), ev('completed', 2, { meta: {} }), ev('reopened', 3, { to_value: 'todo' })];
  const r = buildSegments(todo(), events, T0 + 4 * 3600 * 1000);
  // The first completion closed the bar; later events are ignored by design (the chart shows the current round only).
  assert.equal(r.end, T0 + 2 * 3600 * 1000);
});
