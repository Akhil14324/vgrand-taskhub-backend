const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanReport, defaultStatus, defaultStatusLine } = require('./dayReport');

test('productivity decides the verdict when none is given', () => {
  assert.equal(defaultStatus(6), 'goat');
  assert.equal(defaultStatus(7), 'pottelu');
  assert.equal(cleanReport({ productivity: 9 }).status, 'pottelu');
  assert.equal(cleanReport({ productivity: 2 }).status, 'goat');
});

test('an edited verdict is kept, and the closing line follows it', () => {
  const r = cleanReport({ productivity: 2, status: 'pottelu' });
  assert.equal(r.status, 'pottelu');
  assert.equal(r.status_line, defaultStatusLine('pottelu'));
});

test('ratings are whole numbers from 1 to 10', () => {
  const r = cleanReport({ productivity: 42, scale: -3 });
  assert.equal(r.productivity, 10);
  assert.equal(r.scale, 1);
  assert.equal(cleanReport({ productivity: 'x' }).productivity, 1);
  assert.equal(cleanReport({ productivity: 6.6 }).productivity, 7);
});

test('items are trimmed, empty ones dropped and the list capped', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, text: 'x'.repeat(900) }));
  items.push({ title: '', text: '   ' });
  const r = cleanReport({ items });
  assert.equal(r.items.length, 8);
  assert.equal(r.items[0].text.length, 500);
  assert.deepEqual(cleanReport({ items: ['plain text', {}] }).items, [{ title: '', text: 'plain text' }]);
});

test('time saved: the total follows people x minutes per person', () => {
  const r = cleanReport({ time_saved: { minutes_per_person: 30, people: 40, total_hours: 999 } });
  assert.equal(r.time_saved.total_hours, 20);
  assert.deepEqual(cleanReport({ time_saved: { minutes_per_person: -5, people: 'a' } }).time_saved,
    { minutes_per_person: 0, people: 0, total_hours: 0, note: '' });
});

test('garbage in gives a safe report out', () => {
  const r = cleanReport(null === undefined ? {} : undefined);
  assert.equal(r.items.length, 0);
  assert.equal(r.status, 'goat');
  assert.ok(r.status_line);
});
