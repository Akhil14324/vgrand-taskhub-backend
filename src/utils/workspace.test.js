const test = require('node:test');
const assert = require('node:assert/strict');
const { cumulativeFlow, lastDays, weekStart, lastWeeks, leadCycleByWeek, cleanWip, capacityLevel } = require('./workspace');

test('lastDays ends on today and weekStart finds the Monday', () => {
  assert.deepEqual(lastDays('2026-10-28', 3), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.equal(weekStart('2026-10-28'), '2026-10-26'); // a Wednesday
  assert.equal(weekStart('2026-10-26'), '2026-10-26'); // the Monday itself
  assert.equal(weekStart('2026-11-01'), '2026-10-26'); // a Sunday belongs to the week before
  assert.deepEqual(lastWeeks('2026-10-28', 3), ['2026-10-12', '2026-10-19', '2026-10-26']);
});

test('cumulativeFlow replays status changes and ignores items that did not exist yet', () => {
  const items = [
    { createdOn: '2026-10-01', transitions: [{ on: '2026-10-02', status: 'in_progress' }, { on: '2026-10-03', status: 'done' }], current: 'done' },
    { createdOn: '2026-10-02', transitions: [], current: 'todo' },
  ];
  const flow = cumulativeFlow({ days: ['2026-10-01', '2026-10-02', '2026-10-03'], items, today: '2026-10-03' });
  assert.deepEqual(flow.map((d) => [d.todo, d.in_progress, d.done]), [[1, 0, 0], [1, 1, 0], [1, 0, 1]]);
});

test('cumulativeFlow trusts the real status on the last day', () => {
  const items = [{ createdOn: '2026-10-01', transitions: [], current: 'blocked' }];
  const flow = cumulativeFlow({ days: ['2026-10-01', '2026-10-02'], items, today: '2026-10-02' });
  assert.equal(flow[0].todo, 1);
  assert.equal(flow[1].blocked, 1);
  assert.equal(flow[1].todo, 0);
});

test('leadCycleByWeek averages in hours and leaves empty weeks null', () => {
  const rows = leadCycleByWeek(
    [
      { doneOn: '2026-10-27', leadS: 7200, cycleS: 3600 },
      { doneOn: '2026-10-28', leadS: 14400, cycleS: 7200 },
    ],
    ['2026-10-19', '2026-10-26']
  );
  assert.deepEqual(rows[0], { week: '2026-10-19', done: 0, lead_h: null, cycle_h: null });
  assert.deepEqual(rows[1], { week: '2026-10-26', done: 2, lead_h: 3, cycle_h: 1.5 });
});

test('cleanWip keeps known statuses with whole numbers from 1 to 99', () => {
  assert.deepEqual(cleanWip({ in_progress: '5', blocked: 0, in_review: 100, todo: 3, on_hold: null }), { in_progress: 5 });
  assert.deepEqual(cleanWip(null), {});
  assert.deepEqual(cleanWip({ in_review: 2.5 }), {});
});

test('capacityLevel compares the plan with what the team usually finishes', () => {
  assert.equal(capacityLevel(10, null), 'unknown');
  assert.equal(capacityLevel(10, 0), 'unknown');
  assert.equal(capacityLevel(20, 10), 'over');
  assert.equal(capacityLevel(11, 10), 'ok');
  assert.equal(capacityLevel(4, 10), 'under');
});
