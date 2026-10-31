const test = require('node:test');
const assert = require('node:assert');
const { formulaSource, computeFormulas, computeMirrors, plainValue } = require('./boardCompute');
const { evaluate } = require('./automation/expr');

const columns = [
  { id: 1, title: 'Status', kind: 'status', system_key: 'status', labels: [{ id: 9, label: 'Done', maps_to: 'done' }, { id: 8, label: 'Working on it', maps_to: 'in_progress' }] },
  { id: 2, title: 'Cost', kind: 'numbers', settings: {} },
  { id: 3, title: 'Qty', kind: 'numbers', settings: {} },
  { id: 4, title: 'Total', kind: 'formula', settings: { expression: '{Cost} * {Qty}' } },
  { id: 5, title: 'With tax', kind: 'formula', settings: { expression: 'round({Total} * 1.18, 2)' } },
  { id: 6, title: 'Finished', kind: 'formula', settings: { expression: 'if({Status} == "Done", 1, 0)' } },
  { id: 7, title: 'Broken', kind: 'formula', settings: { expression: '{Nope} + 1' } },
  { id: 10, title: 'Late by', kind: 'formula', settings: { expression: 'days({Due date}, "2026-11-10")' } },
  { id: 11, title: 'Due date', kind: 'date', system_key: 'date' },
];
const items = [
  { id: 100, title: 'Cement', status: 'done', due_date: '2026-11-05' },
  { id: 101, title: 'Steel', status: 'in_progress', due_date: null },
];
const values = { 100: { 2: 350, 3: 40 }, 101: { 2: 1200 } };

test('column names in braces become variables; unknown names are reported', () => {
  assert.deepStrictEqual(formulaSource('{Cost} * {qty}', columns), { src: '%c2 * %c3', missing: [] });
  assert.deepStrictEqual(formulaSource('{Nope}', columns).missing, ['Nope']);
});

test('formulas compute per item, can use an earlier formula, and read status labels', () => {
  const r = computeFormulas(items, columns, values);
  assert.strictEqual(r[100][4], 14000);
  assert.strictEqual(r[100][5], 16520);
  assert.strictEqual(r[100][6], 1);
  assert.strictEqual(r[101][4], 0); // empty Qty counts as 0
  assert.strictEqual(r[101][6], 0);
  assert.match(r[100][7].error, /No column called Nope/);
  assert.strictEqual(r[100][10], 5);
  assert.strictEqual(r[101][10], '');
});

test('the new date functions', () => {
  assert.strictEqual(evaluate('days("2026-11-01", "2026-11-03")'), 2);
  assert.strictEqual(evaluate('addDays("2026-12-30", 3)'), '2027-01-02');
  assert.match(String(evaluate('today()')), /^\d{4}-\d{2}-\d{2}$/);
});

test('mirror shows the linked items\' values in the target column', () => {
  const cols = [{ id: 20, title: 'Supplier', kind: 'board_relation' }, { id: 21, title: 'Supplier phone', kind: 'mirror', settings: { relation_column_id: 20, target_column_id: 30 } }];
  const vals = { 100: { 20: [500, 501] } };
  const linked = { items: [{ id: 500 }, { id: 501 }], columns: [{ id: 30, kind: 'phone' }], values: { 500: { 30: '+91 98480 11111' }, 501: { 30: '+91 98480 22222' } } };
  const r = computeMirrors([{ id: 100 }], cols, vals, linked);
  assert.deepStrictEqual(r[100][21], ['+91 98480 11111', '+91 98480 22222']);
});

test('plain values: dropdown labels, checkbox, person names', () => {
  const dd = { id: 40, kind: 'dropdown', settings: { options: [{ id: 'a', label: 'Cash' }, { id: 'b', label: 'UPI' }] } };
  assert.strictEqual(plainValue({ id: 1 }, dd, { 1: { 40: ['b'] } }), 'UPI');
  assert.strictEqual(plainValue({ id: 1 }, { id: 41, kind: 'checkbox' }, { 1: { 41: true } }), true);
  assert.strictEqual(plainValue({ id: 1 }, { id: 42, kind: 'person' }, { 1: { 42: [3, 8] } }, (id) => ({ 3: 'Kaushal', 8: 'Nagarjuna' })[id]), 'Kaushal,Nagarjuna');
});
