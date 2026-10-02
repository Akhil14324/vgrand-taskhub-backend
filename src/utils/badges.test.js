const test = require('node:test');
const assert = require('node:assert/strict');
const { countCleanMonths, computeBadges } = require('./badges');

test('a zero-late month needs to be over, busy enough and clean', () => {
  const months = [
    { month: '2026-07', done: 12, late: 0 }, // counts
    { month: '2026-08', done: 12, late: 1 }, // one late
    { month: '2026-09', done: 3, late: 0 }, // too quiet
    { month: '2026-10', done: 20, late: 0 }, // still running
  ];
  assert.equal(countCleanMonths(months, '2026-10'), 1);
  assert.equal(countCleanMonths([], '2026-10'), 0);
});

test('badges are earned at their targets and show progress otherwise', () => {
  const badges = computeBadges({ total: 100, longestStreak: 12, cleanMonths: 0, kudos: 3 });
  const by = Object.fromEntries(badges.map((b) => [b.key, b]));
  assert.equal(by.tasks_100.earned, true);
  assert.equal(by.tasks_250.earned, false);
  assert.equal(by.tasks_250.progress, 100);
  assert.equal(by.streak_7.earned, true);
  assert.equal(by.streak_14.earned, false);
  assert.equal(by.streak_14.progress, 12);
  assert.equal(by.clean_month_1.earned, false);
  assert.equal(by.kudos_1.earned, true);
  assert.equal(by.kudos_10.earned, false);
});

test('badge keys are unique', () => {
  const keys = computeBadges({}).map((b) => b.key);
  assert.equal(new Set(keys).size, keys.length);
});
