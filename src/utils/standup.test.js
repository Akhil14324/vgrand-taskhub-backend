const test = require('node:test');
const assert = require('node:assert/strict');
const { lastWorkDay, isWeekend, cleanItems, summary } = require('./standup');

test('lastWorkDay skips the weekend', () => {
  assert.equal(lastWorkDay('2026-10-05'), '2026-10-02'); // Monday -> Friday
  assert.equal(lastWorkDay('2026-10-04'), '2026-10-02'); // Sunday -> Friday
  assert.equal(lastWorkDay('2026-10-07'), '2026-10-06'); // Wednesday -> Tuesday
});

test('isWeekend', () => {
  assert.equal(isWeekend('2026-10-03'), true);
  assert.equal(isWeekend('2026-10-05'), false);
});

test('cleanItems trims, strips tags, drops duplicates and caps the list', () => {
  const out = cleanItems([{ id: 1, title: ' A <b>x</b> ' }, { id: 1, title: 'again' }, { title: '' }, { title: 'free text' }, { title: 'FREE TEXT' }]);
  assert.deepEqual(out, [{ id: 1, title: 'A x' }, { id: null, title: 'free text' }]);
  assert.equal(cleanItems(Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `t${i}` }))).length, 12);
  assert.deepEqual(cleanItems('nope'), []);
});

test('summary', () => {
  assert.equal(summary({ done: [1, 2], doing: [1], blockers: [] }), 'Done 2 · Today 1');
  assert.equal(summary({ done: [], doing: [], blockers: [1] }), 'Done 0 · Today 0 · Blocked 1');
});
