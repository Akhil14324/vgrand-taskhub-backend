const test = require('node:test');
const assert = require('node:assert');
const { compare } = require('./manifest');

const before = {
  tables: {
    todos: { rows: 3, row_hash: 'a', ids: ['1', '2', '3'] },
    migrations: { rows: 2, row_hash: 'm' },
  },
};

test('unchanged data has no problems and no notes', () => {
  const r = compare(before, before);
  assert.deepStrictEqual(r, { problems: [], notes: [] });
});

test('new rows and new tables are notes, not problems', () => {
  const now = {
    tables: {
      todos: { rows: 4, row_hash: 'b', ids: ['1', '2', '3', '4'] },
      migrations: { rows: 3, row_hash: 'n' },
      boards: { rows: 1, row_hash: 'x', ids: ['1'] },
    },
  };
  const r = compare(before, now);
  assert.strictEqual(r.problems.length, 0);
  assert.ok(r.notes.some((n) => n.startsWith('boards: new table')));
});

test('a missing id is a problem even when the count stays the same', () => {
  const now = { tables: { ...before.tables, todos: { rows: 3, row_hash: 'c', ids: ['1', '2', '9'] } } };
  const r = compare(before, now);
  assert.ok(r.problems.some((p) => p.includes('todos: 1 id(s) missing')));
});

test('fewer rows or a dropped table is a problem', () => {
  const now = { tables: { todos: { rows: 2, row_hash: 'd', ids: ['1', '2'] } } };
  const r = compare(before, now);
  assert.ok(r.problems.some((p) => p.startsWith('todos: rows 3 -> 2')));
  assert.ok(r.problems.some((p) => p === 'migrations: table is gone'));
});
