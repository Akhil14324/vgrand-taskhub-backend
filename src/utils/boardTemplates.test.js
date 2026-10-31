const test = require('node:test');
const assert = require('node:assert');
const { BUILT_INS, checkDefinition } = require('./boardTemplates');
const columns = require('./columns');

test('every ready-made template is valid against the column catalog', () => {
  for (const [key, t] of Object.entries(BUILT_INS)) {
    assert.deepStrictEqual(checkDefinition(t.definition, columns), [], key);
    assert.ok(t.name && t.description, key);
  }
});

test('a broken definition is reported, not trusted', () => {
  const problems = checkDefinition({
    columns: [{ kind: 'nope', title: 'X' }, { system_key: 'nope' }, { kind: 'status', title: 'S', labels: [{ label: 'A', color: 'teal' }] }],
    groups: [{ name: '', color: 'neon' }],
    views: [{ kind: 'map3d' }],
  }, columns);
  assert.strictEqual(problems.length, 6);
});
