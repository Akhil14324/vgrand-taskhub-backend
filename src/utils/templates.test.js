const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeTree, fillTokens, treeFromRows, addDays, daysBetween } = require('./templates');

test('sanitizeTree keeps a nested tree and counts items', () => {
  const r = sanitizeTree([{ title: 'Onboard client', children: [{ title: 'Collect KYC', offset_days: 2, priority: 1 }, { title: 'Send welcome' }] }]);
  assert.equal(r.count, 3);
  assert.equal(r.tree[0].children[0].priority, 1);
  assert.equal(r.tree[0].children[0].offset_days, 2);
});

test('sanitizeTree rejects empty titles and empty trees', () => {
  assert.ok(sanitizeTree([]).error);
  assert.ok(sanitizeTree([{ title: '  ' }]).error);
});

test('sanitizeTree only keeps recurrence on the top level', () => {
  const r = sanitizeTree([{ title: 'A', recurrence: 'monthly', children: [{ title: 'B', recurrence: 'daily' }] }]);
  assert.equal(r.tree[0].recurrence, 'monthly');
  assert.equal(r.tree[0].children[0].recurrence, undefined);
});

test('sanitizeTree limits depth and size', () => {
  let deep = { title: 'x' };
  for (let i = 0; i < 8; i += 1) deep = { title: 'x', children: [deep] };
  assert.ok(sanitizeTree([deep]).error);
  const many = Array.from({ length: 130 }, (_, i) => ({ title: `t${i}` }));
  assert.ok(sanitizeTree(many).error);
});

test('fillTokens', () => {
  assert.equal(fillTokens('GST {month}', '2026-10-05'), 'GST October 2026');
  assert.equal(fillTokens('Review {date}', '2026-10-05'), 'Review 5 Oct 2026');
});

test('date helpers', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(daysBetween('2026-10-01', '2026-10-08'), 7);
});

test('treeFromRows turns dates into offsets from the root', () => {
  const rows = [
    { id: 1, parent_id: null, title: 'Root', due_date: '2026-10-10', priority: 4, labels: [] },
    { id: 2, parent_id: 1, title: 'Child', due_date: '2026-10-12', priority: 1, labels: ['x'] },
  ];
  const tree = treeFromRows(rows, 1);
  assert.equal(tree[0].offset_days, 0);
  assert.equal(tree[0].children[0].offset_days, 2);
  assert.equal(tree[0].children[0].priority, 1);
});
