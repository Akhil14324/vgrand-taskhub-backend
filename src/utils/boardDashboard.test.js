const test = require('node:test');
const assert = require('node:assert');
const { cleanWidgets } = require('./boardDashboard');

test('drops unknown types, clamps size, keeps known fields', () => {
  const out = cleanWidgets([{ id: 'a', type: 'chart', w: 9, by: 'status', chart: 'donut', evil: 1 }, { type: 'nope' }, null]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], { id: 'a', type: 'chart', title: '', w: 3, by: 'status', chart: 'donut' });
});

test('with a schema, unknown columns are dropped', () => {
  const schema = { columns: [{ id: 5 }] };
  const [w] = cleanWidgets([{ type: 'number', value: '9', by: 'col:9' }, { type: 'number', value: '5', by: 'col:5' }], schema);
  assert.strictEqual(w.value, undefined);
  assert.strictEqual(w.by, undefined);
  const out = cleanWidgets([{ type: 'number', value: '5', by: 'col:5' }], schema);
  assert.strictEqual(out[0].value, '5');
  assert.strictEqual(out[0].by, 'col:5');
});

test('duplicate ids are made unique', () => {
  const out = cleanWidgets([{ id: 'x', type: 'text' }, { id: 'x', type: 'text' }]);
  assert.notStrictEqual(out[0].id, out[1].id);
});
