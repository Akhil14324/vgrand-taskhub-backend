const test = require('node:test');
const assert = require('node:assert');
const { resolvePeriod, shift, daysBetween } = require('./monitorReport');

// 2026-11-23 is a Monday.
const today = '2026-11-23';
const r = (preset) => { const p = resolvePeriod({ preset }, today); return [p.from, p.to]; };

test('presets resolve to the right calendar days', () => {
  assert.deepStrictEqual(r('today'), ['2026-11-23', '2026-11-23']);
  assert.deepStrictEqual(r('yesterday'), ['2026-11-22', '2026-11-22']);
  assert.deepStrictEqual(r('last7'), ['2026-11-17', '2026-11-23']);
  assert.strictEqual(daysBetween(...r('last7')) + 1, 7);
  assert.deepStrictEqual(r('last30'), ['2026-10-25', '2026-11-23']);
  assert.strictEqual(daysBetween(...r('last30')) + 1, 30);
});

test('weeks start on Monday and months follow the calendar', () => {
  assert.deepStrictEqual(r('this_week'), ['2026-11-23', '2026-11-23']);
  assert.deepStrictEqual(r('last_week'), ['2026-11-16', '2026-11-22']);
  assert.deepStrictEqual(r('this_month'), ['2026-11-01', '2026-11-23']);
  assert.deepStrictEqual(r('last_month'), ['2026-10-01', '2026-10-31']);
  const midweek = resolvePeriod({ preset: 'this_week' }, '2026-11-26');
  assert.deepStrictEqual([midweek.from, midweek.to], ['2026-11-23', '2026-11-26']);
  const jan = resolvePeriod({ preset: 'last_month' }, '2027-01-15');
  assert.deepStrictEqual([jan.from, jan.to], ['2026-12-01', '2026-12-31']);
  const leap = resolvePeriod({ preset: 'last_month' }, '2028-03-10');
  assert.deepStrictEqual([leap.from, leap.to], ['2028-02-01', '2028-02-29']);
});

test('a custom range must be complete, in order and not huge', () => {
  assert.deepStrictEqual(Object.values(resolvePeriod({ preset: 'custom', from: '2026-11-01', to: '2026-11-23' }, today)).slice(1, 3), ['2026-11-01', '2026-11-23']);
  assert.throws(() => resolvePeriod({ preset: 'custom', from: '2026-11-24', to: '2026-11-01' }, today), /start date cannot be later/);
  assert.throws(() => resolvePeriod({ preset: 'custom', from: '2026-11-01' }, today), /start date and an end date/);
  assert.throws(() => resolvePeriod({ preset: 'custom', from: '2024-01-01', to: '2026-11-23' }, today), /at most/);
  assert.throws(() => resolvePeriod({ preset: 'nonsense' }, today), /Unknown/);
  assert.strictEqual(shift('2026-03-01', -1), '2026-02-28');
});
