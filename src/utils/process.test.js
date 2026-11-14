const test = require('node:test');
const assert = require('node:assert');
const { buildProcess, orderSteps } = require('./process');

const at = (d, h = 0) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const DAY = 86400;

test('steps come out in reading order with depth and leaves', () => {
  const rows = [
    { id: 3, parent_id: 1, created_at: at(2) }, { id: 2, parent_id: 1, created_at: at(1) },
    { id: 4, parent_id: 2, created_at: at(3) },
  ];
  assert.deepStrictEqual(orderSteps(1, rows).map((s) => [s.row.id, s.depth, s.leaf]), [[2, 0, false], [4, 1, true], [3, 0, true]]);
});

test('a finished task: total time, step times and their share, days late', () => {
  const todo = { id: 1, title: 'Tender', created_at: at(1), assigned_at: at(1), started_at: at(2), is_done: true, done_at: at(11), due_date: '2026-11-08', status: 'done', status_seconds: { todo: DAY, in_progress: 7 * DAY, blocked: 2 * DAY }, assignee_id: 7, created_by: 7 };
  const steps = [
    { id: 2, parent_id: 1, title: 'Survey', created_at: at(1), started_at: at(2), is_done: true, done_at: at(5), status_seconds: {} },
    { id: 3, parent_id: 1, title: 'Quote', created_at: at(1), started_at: at(5), is_done: true, done_at: at(6), status_seconds: {}, duration_minutes: 120 },
    { id: 4, parent_id: 1, title: 'Sign', created_at: at(1), is_done: false, status: 'todo', status_seconds: {} },
  ];
  const p = buildProcess({ todo, steps, events: [{ kind: 'due_changed', created_at: at(4) }], nameOf: () => 'Ravi' }, Date.UTC(2026, 10, 20));
  assert.strictEqual(p.numbers.total_s, 10 * DAY);
  assert.strictEqual(p.numbers.blocked_s, 2 * DAY);
  assert.strictEqual(p.numbers.late_days, 3);
  assert.strictEqual(p.numbers.steps_total, 3);
  assert.strictEqual(p.numbers.steps_done, 2);
  assert.strictEqual(p.numbers.date_changes, 1);
  assert.deepStrictEqual(p.steps.map((s) => [s.took_s, s.share]), [[3 * DAY, 75], [DAY, 25], [null, 0]]);
  assert.strictEqual(p.numbers.slowest_step.title, 'Survey');
  assert.strictEqual(p.numbers.estimate_s, 7200);
  assert.deepStrictEqual(p.stages.map((s) => s.status), ['todo', 'in_progress', 'blocked']);
  assert.strictEqual(p.holders[0].name, 'Ravi');
});

test('waiting for another task counts from the link until that task finished', () => {
  const todo = { id: 1, title: 'Pour slab', created_at: at(1), is_done: false, status: 'todo', status_seconds: {} };
  const p = buildProcess({
    todo,
    waitsFor: [
      { id: 9, title: 'Steel delivery', is_done: true, done_at: at(4), linked_at: at(1) },
      { id: 8, title: 'Old work', is_done: true, done_at: at(0), linked_at: at(1) },
      { id: 7, title: 'Permit', is_done: false, linked_at: at(2) },
    ],
  }, Date.UTC(2026, 10, 6));
  assert.deepStrictEqual(p.waits_for.map((w) => w.waited_s), [3 * DAY, 0, 4 * DAY]);
  assert.strictEqual(p.numbers.waiting_on_others_s, 4 * DAY);
  assert.strictEqual(p.numbers.late_days, null);
});
