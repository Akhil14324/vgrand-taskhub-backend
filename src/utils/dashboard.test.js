const test = require('node:test');
const assert = require('node:assert');
const { computeWidget } = require('./dashboard');

const items = [
  { id: 1, title: 'Pour slab', status: 'done', is_done: true, assignee_id: 8, assignee_name: 'Nagarjuna', board_id: 1, due_date: '2026-10-20', priority: 2 },
  { id: 2, title: 'Order steel', status: 'in_progress', is_done: false, assignee_id: 8, assignee_name: 'Nagarjuna', board_id: 1, due_date: '2026-10-25', priority: 1 },
  { id: 3, title: 'Kitchen gas', status: 'blocked', is_done: false, assignee_id: 6, assignee_name: 'Chandrasekhar', board_id: 2, due_date: '2026-11-03', priority: 3 },
  { id: 4, title: 'Menu photos', status: 'todo', is_done: false, assignee_id: null, board_id: 2, due_date: null },
  { id: 5, title: 'sub', status: 'todo', is_done: false, parent_id: 2, board_id: 1 },
];
const ctx = {
  today: '2026-10-31', weekEnd: '2026-11-07', meId: 8,
  boards: new Map([[1, 'Tripura'], [2, 'Ongolu']]),
  values: { 1: { 50: 120000 }, 2: { 50: 80000 } },
  columnIdsByTitle: new Map([['cost', [50]]]),
};

test('numbers: counts with a filter, or sums a column by name', () => {
  assert.deepStrictEqual(computeWidget('numbers', {}, items, ctx), { value: 4 }); // sub-items are not counted
  assert.deepStrictEqual(computeWidget('numbers', { filter: 'overdue' }, items, ctx), { value: 1 });
  assert.deepStrictEqual(computeWidget('numbers', { column: 'Cost', unit: '₹' }, items, ctx), { value: 200000, unit: '₹' });
});

test('battery and status', () => {
  assert.deepStrictEqual(computeWidget('battery', {}, items, ctx), { done: 1, total: 4, percent: 25 });
  const s = computeWidget('status', {}, items, ctx).bars.map((b) => [b.key, b.count]);
  assert.deepStrictEqual(s, [['todo', 1], ['in_progress', 1], ['blocked', 1], ['done', 1]]);
});

test('chart by person and by board', () => {
  assert.deepStrictEqual(computeWidget('chart', { by: 'person' }, items, ctx).bars.map((b) => [b.label, b.count]), [['Nagarjuna', 2], ['Chandrasekhar', 1], ['Nobody', 1]]);
  assert.deepStrictEqual(computeWidget('chart', { by: 'board' }, items, ctx).bars.map((b) => [b.label, b.count]), [['Tripura', 2], ['Ongolu', 2]]);
});

test('workload, upcoming and overdue', () => {
  assert.deepStrictEqual(computeWidget('workload', {}, items, ctx).people, [
    { id: 8, name: 'Nagarjuna', open: 1, overdue: 1 }, { id: 6, name: 'Chandrasekhar', open: 1, overdue: 0 },
  ]);
  assert.deepStrictEqual(computeWidget('upcoming', {}, items, ctx).items.map((t) => t.id), [3]);
  assert.deepStrictEqual(computeWidget('overdue', {}, items, ctx).items.map((t) => t.id), [2]);
});
