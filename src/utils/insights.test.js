const test = require('node:test');
const assert = require('node:assert/strict');
const {
  healthScore, healthLevel, workloadState, loadMinutes, estimateSummary, estimateVerdict,
  keyResultProgress, goalProgress, goalPace, attentionReasons,
} = require('./insights');
const { daysBetween } = require('./templates');

test('a quiet business is healthy and a struggling one is not', () => {
  assert.equal(healthScore({ open: 0, overdue: 0, blocked: 0, unassigned: 0, on_time_rate: null }), 100);
  assert.equal(healthScore({ open: 10, overdue: 0, blocked: 0, unassigned: 0, on_time_rate: 100 }), 100);
  const bad = healthScore({ open: 10, overdue: 10, blocked: 5, unassigned: 5, on_time_rate: 20 });
  assert.ok(bad < 30, `score ${bad}`);
  assert.equal(healthLevel(bad), 'red');
  assert.equal(healthLevel(80), 'green');
  assert.equal(healthLevel(60), 'orange');
});

test('attention reasons name the problems', () => {
  const r = attentionReasons({ overdue: 3, blocked: 0, unassigned: 2, on_time_rate: 40, completed_change: -50 });
  assert.deepEqual(r, ['3 overdue', '2 with no owner', 'only 40% finished on time', 'output down 50%']);
});

test('workload states by share of a five-day capacity', () => {
  assert.equal(workloadState(300).state, 'light');
  assert.equal(workloadState(1500).state, 'balanced');
  assert.equal(workloadState(2200).state, 'heavy');
  assert.equal(workloadState(3000).state, 'overloaded');
});

test('load counts overdue, this week and started work, with a default estimate', () => {
  const tasks = [
    { due_date: '2026-10-01', duration_minutes: 120, status: 'todo' },
    { due_date: '2026-10-06', duration_minutes: null, status: 'todo' },
    { due_date: '2026-11-30', duration_minutes: 500, status: 'todo' },
    { due_date: null, duration_minutes: 30, status: 'in_progress' },
  ];
  assert.equal(loadMinutes(tasks, '2026-10-03', '2026-10-10'), 120 + 60 + 30);
});

test('estimate summary compares time spent with the estimate', () => {
  const s = estimateSummary([
    { estimate_min: 60, active_s: 3600 },
    { estimate_min: 60, active_s: 7200 },
    { estimate_min: null, active_s: 100 },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.ratio, 1.5);
  assert.equal(s.within, 50);
  assert.equal(estimateSummary([]).ratio, null);
  assert.equal(estimateVerdict(1.0), 'accurate');
  assert.equal(estimateVerdict(2), 'much_slower');
  assert.equal(estimateVerdict(0.5), 'fast');
});

test('key result progress for numbers and linked to-dos', () => {
  assert.equal(keyResultProgress({ kind: 'number', start_value: 0, target_value: 100, current_value: 25 }), 0.25);
  assert.equal(keyResultProgress({ kind: 'number', start_value: 100, target_value: 50, current_value: 75 }), 0.5);
  assert.equal(keyResultProgress({ kind: 'number', start_value: 0, target_value: 10, current_value: 99 }), 1);
  assert.equal(keyResultProgress({ kind: 'todos', todos_total: 4, todos_done: 1 }), 0.25);
  assert.equal(keyResultProgress({ kind: 'todos', todos_total: 0, todos_done: 0 }), 0);
  assert.equal(goalProgress([]), 0);
  assert.equal(goalProgress([{ kind: 'todos', todos_total: 2, todos_done: 2 }, { kind: 'todos', todos_total: 2, todos_done: 0 }]), 0.5);
});

test('goal pace compares progress with elapsed time', () => {
  const pace = (p, today) => goalPace(p, '2026-10-01', '2026-10-30', today, daysBetween);
  assert.equal(pace(1, '2026-10-10'), 'done');
  assert.equal(pace(0, '2026-09-20'), 'upcoming');
  assert.equal(pace(0.5, '2026-10-15'), 'on_track');
  assert.equal(pace(0.4, '2026-10-15'), 'at_risk');
  assert.equal(pace(0.1, '2026-10-15'), 'behind');
  assert.equal(pace(0.9, '2026-11-05'), 'behind');
});
