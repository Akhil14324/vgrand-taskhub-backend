const test = require('node:test');
const assert = require('node:assert/strict');
const { rankRows } = require('./leaderboard');

const row = (name, completed, on_time_rate, streak) => ({ name, completed, on_time_rate, streak });

test('most finished work ranks first', () => {
  const out = rankRows([row('B', 3, 100, 1), row('A', 5, 50, 0)]);
  assert.deepEqual(out.map((r) => [r.name, r.rank]), [['A', 1], ['B', 2]]);
});

test('ties share a rank and fall back to on-time rate, then streak', () => {
  const out = rankRows([row('A', 4, 80, 2), row('B', 4, 90, 1), row('C', 4, 90, 1)]);
  assert.deepEqual(out.map((r) => [r.name, r.rank]), [['B', 1], ['C', 1], ['A', 3]]);
});

test('nobody with a missing on-time rate beats someone with one', () => {
  const out = rankRows([row('A', 2, null, 0), row('B', 2, 10, 0)]);
  assert.equal(out[0].name, 'B');
});
