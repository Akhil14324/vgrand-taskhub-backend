const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanPoints, addDaysYmd, daysInclusive, summarize, burndown, averageVelocity } = require('./sprints');

test('cleanPoints accepts unset and whole numbers from 0 to 100', () => {
  assert.deepEqual(cleanPoints(null), { value: null });
  assert.deepEqual(cleanPoints(''), { value: null });
  assert.deepEqual(cleanPoints('5'), { value: 5 });
  assert.deepEqual(cleanPoints(0), { value: 0 });
  assert.ok(cleanPoints(101).error);
  assert.ok(cleanPoints(-1).error);
  assert.ok(cleanPoints(2.5).error);
  assert.ok(cleanPoints('abc').error);
});

test('addDaysYmd and daysInclusive stay on calendar days across month and year ends', () => {
  assert.equal(addDaysYmd('2026-02-27', 2), '2026-03-01');
  assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  assert.equal(daysInclusive('2026-10-01', '2026-10-01'), 1);
  assert.equal(daysInclusive('2026-10-01', '2026-10-14'), 14);
});

test('summarize totals points and counts finished work', () => {
  const out = summarize([
    { points: 3, is_done: true },
    { points: 5, is_done: false },
    { points: null, is_done: false },
  ]);
  assert.deepEqual(out, { total_count: 3, done_count: 1, total_points: 8, done_points: 3 });
});

test('burndown runs ideal from total to zero and reads remaining from finish dates', () => {
  const series = burndown({
    startsOn: '2026-10-01',
    endsOn: '2026-10-05',
    today: '2026-10-03',
    items: [
      { points: 4, doneOn: '2026-10-02' },
      { points: 6, doneOn: null },
    ],
  });
  assert.equal(series.length, 5);
  assert.deepEqual(series.map((d) => d.ideal), [10, 8, 5, 3, 0]);
  assert.deepEqual(series.map((d) => d.remaining), [10, 6, 6, null, null]);
  assert.equal(series[0].date, '2026-10-01');
  assert.equal(series[4].date, '2026-10-05');
});

test('burndown handles a one-day sprint and an empty sprint', () => {
  const one = burndown({ startsOn: '2026-10-01', endsOn: '2026-10-01', today: '2026-10-01', items: [{ points: 2, doneOn: null }] });
  assert.deepEqual(one, [{ date: '2026-10-01', ideal: 0, remaining: 2 }]);
  const none = burndown({ startsOn: '2026-10-01', endsOn: '2026-10-03', today: '2026-10-03', items: [] });
  assert.deepEqual(none.map((d) => d.remaining), [0, 0, 0]);
});

test('averageVelocity uses the last three completed sprints and is null with none', () => {
  assert.equal(averageVelocity([]), null);
  assert.equal(averageVelocity([10]), 10);
  assert.equal(averageVelocity([2, 4, 6, 9]), 6.3);
});
