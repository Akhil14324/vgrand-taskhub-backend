const test = require('node:test');
const assert = require('node:assert/strict');
const { nextReminderDate } = require('./todoReminders');

test('a daily reminder moves to the next day', () => {
  assert.equal(nextReminderDate('2026-10-07', 'daily', '2026-10-07'), '2026-10-08');
});

test('a weekly reminder moves a week ahead', () => {
  assert.equal(nextReminderDate('2026-10-07', 'weekly', '2026-10-07'), '2026-10-14');
});

test('a monthly reminder keeps the day and clamps to the end of a short month', () => {
  assert.equal(nextReminderDate('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
});

test('a reminder that was missed for weeks skips to the first date that is not in the past', () => {
  assert.equal(nextReminderDate('2026-09-01', 'weekly', '2026-10-08'), '2026-10-13');
});
