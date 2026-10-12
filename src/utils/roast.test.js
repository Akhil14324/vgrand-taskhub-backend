const test = require('node:test');
const assert = require('node:assert');
const { roastLine, daysBetween, LINES } = require('./roast');
const { cleanFeatures } = require('./features');

test('roastLine names the task and the days, and rotates', () => {
  const first = roastLine('Send invoice', 4, 0);
  assert.match(first, /Send invoice/);
  assert.match(first, /4/);
  assert.notStrictEqual(roastLine('Send invoice', 4, 1), first);
  assert.strictEqual(roastLine('Send invoice', 4, LINES.length), first);
});

test('roastLine shortens a very long title', () => {
  assert.ok(roastLine('x'.repeat(200), 3).length < 140);
});

test('daysBetween counts whole days across a month end', () => {
  assert.strictEqual(daysBetween('2026-10-09', '2026-10-12'), 3);
  assert.strictEqual(daysBetween('2026-09-29', '2026-10-02'), 3);
});

test('cleanFeatures keeps known boolean switches only', () => {
  assert.deepStrictEqual(cleanFeatures({ water: false, roast: true, hacker: true, focus: 'yes' }), { water: false, roast: true });
  assert.deepStrictEqual(cleanFeatures({}), {});
  assert.strictEqual(cleanFeatures(null), null);
  assert.strictEqual(cleanFeatures([true]), null);
});
