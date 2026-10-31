const test = require('node:test');
const assert = require('node:assert');
const { measure, stallOf } = require('./processes');

const leaf = (is_done, duration_minutes = null, done_at = null) => ({ is_done, duration_minutes, done_at });

test('without estimates every step counts the same', () => {
  const m = measure([leaf(true, null, '2026-10-01'), leaf(false), leaf(false), leaf(false)]);
  assert.deepStrictEqual([m.total, m.done, m.pct, m.weighted], [4, 1, 25, false]);
});

test('a long step weighs more than a short one', () => {
  // 4 hours done, 15 minutes left: nearly finished by time, though only half by count
  const m = measure([leaf(true, 240, '2026-10-01'), leaf(false, 15)]);
  assert.strictEqual(m.pct, 94);
  assert.strictEqual(m.weighted, true);
});

test('a step with no estimate takes the average of the others', () => {
  const m = measure([leaf(true, 60, '2026-10-01'), leaf(false, 180), leaf(false)]); // average 120
  assert.strictEqual(m.pct, Math.round((60 / (60 + 180 + 120)) * 100));
});

test('the last finished step is remembered', () => {
  const m = measure([leaf(true, null, '2026-10-01T10:00:00Z'), leaf(true, null, '2026-10-05T10:00:00Z'), leaf(false)]);
  assert.strictEqual(new Date(m.lastStepAt).toISOString(), '2026-10-05T10:00:00.000Z');
});

const now = new Date('2026-10-20T09:00:00Z');
const m = (done, total, lastStepAt) => ({ total, done, lastStepAt });

test('quiet for days with the date close is stalled', () => {
  const s = stallOf(m(1, 4, '2026-10-14T09:00:00Z'), { created_at: '2026-10-01', due_date: '2026-10-24' }, now);
  assert.strictEqual(s.stalled, true);
  assert.strictEqual(s.idleDays, 6);
});

test('a recent step means not stalled', () => {
  assert.strictEqual(stallOf(m(1, 4, '2026-10-19T09:00:00Z'), { created_at: '2026-10-01', due_date: '2026-10-24' }, now).stalled, false);
});

test('quiet but the date is far away is not stalled', () => {
  assert.strictEqual(stallOf(m(1, 4, '2026-10-10T09:00:00Z'), { created_at: '2026-10-01', due_date: '2026-12-31' }, now).stalled, false);
});

test('no date: stalled only after twice as long', () => {
  assert.strictEqual(stallOf(m(1, 4, '2026-10-16T09:00:00Z'), { created_at: '2026-10-01', due_date: null }, now).stalled, false);
  assert.strictEqual(stallOf(m(1, 4, '2026-10-10T09:00:00Z'), { created_at: '2026-10-01', due_date: null }, now).stalled, true);
});

test('a finished process or one with a single step is never stalled', () => {
  assert.strictEqual(stallOf(m(4, 4, '2026-10-01T09:00:00Z'), { created_at: '2026-09-01', due_date: '2026-10-21' }, now).stalled, false);
  assert.strictEqual(stallOf(m(0, 1, null), { created_at: '2026-09-01', due_date: '2026-10-21' }, now).stalled, false);
});

test('an overdue process that has been quiet is stalled', () => {
  assert.strictEqual(stallOf(m(1, 3, '2026-10-10T09:00:00Z'), { created_at: '2026-10-01', due_date: '2026-10-15' }, now).stalled, true);
});
