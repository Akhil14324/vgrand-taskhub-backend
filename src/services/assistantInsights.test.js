const test = require('node:test');
const assert = require('node:assert');
const { buildOverview, buildReport, classify, workload, addDays } = require('./assistantInsights');

// A fixed "now" at noon UTC (afternoon in Asia/Kolkata), so the app-zone day is stable.
const NOW = Date.parse('2026-11-23T08:00:00Z');
const TODAY = '2026-11-23';
const ME = { id: 1, name: 'Me' };
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

let nextId = 1;
const todo = (o) => ({
  id: nextId++, title: `T${nextId}`, priority: 3, status: 'todo', is_done: false, parent_id: null, review_state: 'accepted',
  created_by: 1, assignee_id: null, is_member: true, watching: false, business_id: null, due_date: null, deadline_date: null,
  updated_at: ago(0), done_at: null, subtask_count: 0, subtask_done_count: 0, open_blocker_count: 0, depends_on: null, ...o,
});

test('classify splits my work, given to me, given by me and team', () => {
  const rows = [
    todo({}), // mine, personal
    todo({ assignee_id: 1, created_by: 2, business_id: 5 }), // to me
    todo({ assignee_id: 3, created_by: 1, business_id: 5, watching: true, is_member: true }), // by me
    todo({ assignee_id: 4, created_by: 2, business_id: 5, is_member: false }), // team only
    todo({ parent_id: 1 }), // sub-task: not counted
  ];
  const c = classify(rows, 1);
  assert.strictEqual(c.mine.length, 2);
  assert.strictEqual(c.toMe.length, 1);
  assert.strictEqual(c.byMe.length, 1);
  assert.strictEqual(c.team.length, 3);
});

test('overview counts come from the data only', () => {
  const rows = [
    todo({ due_date: TODAY, priority: 1 }),
    todo({ due_date: addDays(TODAY, -2) }), // overdue
    todo({ is_done: true, status: 'done', done_at: ago(0) }), // completed today
    todo({ is_done: true, status: 'done', done_at: ago(3) }), // completed earlier
    todo({}), todo({}), todo({}), // no date x3
    todo({ assignee_id: 7, created_by: 1, business_id: 2, updated_at: ago(5) }), // given out, not updated
  ];
  const o = buildOverview(rows, ME, NOW);
  assert.strictEqual(o.today, TODAY);
  assert.strictEqual(o.counts.due_today, 1);
  assert.strictEqual(o.counts.overdue, 1);
  assert.strictEqual(o.counts.completed_today, 1);
  assert.strictEqual(o.counts.pending, 5);
  assert.strictEqual(o.counts.no_date, 3);
  assert.strictEqual(o.counts.assigned_by_me, 1);
  const kinds = o.insights.map((i) => i.kind);
  assert.ok(kinds.includes('overdue'));
  assert.ok(kinds.includes('no_deadline'));
  assert.ok(kinds.includes('assigned_stale'));
  assert.ok(!kinds.includes('high_done'), 'an open priority-1 to-do means high priority is not all done');
});

test('no insight is made up when there is nothing to say', () => {
  const o = buildOverview([todo({ due_date: addDays(TODAY, 3) })], ME, NOW);
  assert.deepStrictEqual(o.insights, []);
});

test('date clashes and "all high priority done"', () => {
  const day = addDays(TODAY, 2);
  const rows = [todo({ due_date: day }), todo({ due_date: day }), todo({ due_date: day }), todo({ priority: 1, is_done: true, status: 'done', done_at: ago(1) })];
  const o = buildOverview(rows, ME, NOW);
  assert.strictEqual(o.conflicts.length, 1);
  assert.strictEqual(o.conflicts[0].count, 3);
  assert.ok(o.insights.some((i) => i.kind === 'high_done'));
});

test('workload flags the overloaded person only when someone else is light', () => {
  const rows = [];
  for (let i = 0; i < 8; i += 1) rows.push(todo({ business_id: 1, assignee_id: 10, assignee_name: 'Busy' }));
  rows.push(todo({ business_id: 1, assignee_id: 11, assignee_name: 'Light' }));
  rows.push(todo({ business_id: 1, assignee_id: 12, assignee_name: 'Mid' }), todo({ business_id: 1, assignee_id: 12, assignee_name: 'Mid' }));
  const w = workload(rows, TODAY, 1);
  assert.strictEqual(w.people[0].name, 'Busy');
  assert.ok(w.people[0].overloaded);
  assert.ok(w.people.find((p) => p.name === 'Light').light);
  assert.ok(w.uneven);
});

test('daily and weekly reports', () => {
  const rows = [
    todo({ is_done: true, status: 'done', done_at: ago(0), priority: 1 }),
    todo({ is_done: true, status: 'done', done_at: ago(2) }),
    todo({ is_done: true, status: 'done', done_at: ago(9) }), // last week
    todo({ due_date: TODAY }),
    todo({ due_date: addDays(TODAY, 1), priority: 2 }),
    todo({ due_date: addDays(TODAY, -1) }),
  ];
  const d = buildReport(rows, ME, 'day', NOW);
  assert.strictEqual(d.completed, 1);
  assert.strictEqual(d.tomorrow.length, 1);
  assert.strictEqual(d.delayed.length, 1);
  const w = buildReport(rows, ME, 'week', NOW);
  assert.strictEqual(w.completed, 2);
  assert.strictEqual(w.previous_week_completed, 1);
  assert.strictEqual(w.trend, 'up');
  assert.strictEqual(w.pending, 3);
  assert.strictEqual(w.progress_pct, 50); // 2 done of 2 done + 2 open due by today
  assert.strictEqual(w.per_day.length, 7);
});
