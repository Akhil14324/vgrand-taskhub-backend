const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStreak } = require('./streak');

// 2026-10-05 is a Monday.
const days = (list) => new Map(list.map((d) => [d, 1]));

test('consecutive weekdays build a streak', () => {
  const r = computeStreak(days(['2026-10-05', '2026-10-06', '2026-10-07']), new Set(), '2026-10-07');
  assert.equal(r.current, 3);
});

test('today without a completion does not break the streak yet', () => {
  const r = computeStreak(days(['2026-10-05', '2026-10-06']), new Set(), '2026-10-07');
  assert.equal(r.current, 2);
});

test('a missed weekday breaks it', () => {
  const r = computeStreak(days(['2026-10-05', '2026-10-07']), new Set(), '2026-10-07');
  assert.equal(r.current, 1);
});

test('weekends are bridged', () => {
  // Fri 2 Oct and Mon 5 Oct, nothing on the weekend.
  const r = computeStreak(days(['2026-10-02', '2026-10-05']), new Set(), '2026-10-05');
  assert.equal(r.current, 2);
});

test('a chosen rest day is bridged', () => {
  const r = computeStreak(days(['2026-10-05', '2026-10-07']), new Set(['2026-10-06']), '2026-10-07');
  assert.equal(r.current, 2);
});

test('longest streak is remembered after a break', () => {
  const r = computeStreak(days(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05']), new Set(), '2026-10-05');
  assert.equal(r.longest, 4);
  assert.equal(r.current, 1);
});
