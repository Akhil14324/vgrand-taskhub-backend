const test = require('node:test');
const assert = require('node:assert');
const { cleanBox, statusOf, summarize, editable, sendProblem } = require('./timebox');

test('cleanBox keeps three priorities, sorts blocks and leaves out broken or overlapping ones', () => {
  const { box, errors } = cleanBox({
    priorities: ['Site visit Tripura', { text: 'Pay contractor', todo_id: '42' }, 'Call bank', 'Fourth'],
    brain_dump: ['', 'Order cement', { text: '  Menu photos  ' }],
    blocks: [
      { start: '10:00', end: '11:00', text: 'Pay contractor', priority: 1 },
      { start: '09:00', end: '10:00', text: 'Site visit', priority: 0, done: true },
      { start: '10:30', end: '11:30', text: 'Overlaps' },
      { start: '12:15', end: '13:00', text: 'Not on the half hour' },
      { start: '14:00', end: '13:00', text: 'Backwards' },
      { start: '15:00', end: '15:30', text: '' },
      { start: '16:00', end: '17:00', text: 'Bank', priority: 7 },
    ],
    reflection: 'Good day',
  });
  assert.deepStrictEqual(box.priorities.map((p) => p.text), ['Site visit Tripura', 'Pay contractor', 'Call bank']);
  assert.strictEqual(box.priorities[1].todo_id, 42);
  assert.deepStrictEqual(box.brain_dump.map((p) => p.text), ['Order cement', 'Menu photos']);
  assert.deepStrictEqual(box.blocks.map((b) => b.start), ['09:00', '10:00', '16:00']);
  assert.strictEqual(box.blocks[0].done, true);
  assert.strictEqual(box.blocks[1].done, null);
  assert.strictEqual(box.blocks[2].priority, null);
  assert.strictEqual(errors.length, 4); // too many priorities, overlap, quarter hour, backwards
});

test('status and summary', () => {
  assert.strictEqual(statusOf(null), 'none');
  assert.strictEqual(statusOf({ priorities: [], blocks: [], brain_dump: [], reflection: '' }), 'none');
  const row = {
    priorities: [{ text: 'a', done: true }, { text: 'b', done: false }],
    blocks: [{ start: '09:00', end: '10:30', done: true }, { start: '11:00', end: '12:00', done: false }, { start: '14:00', end: '14:30', done: null }],
    brain_dump: [], reflection: '',
  };
  assert.strictEqual(statusOf(row), 'planned');
  assert.strictEqual(statusOf({ ...row, submitted_at: new Date() }), 'sent');
  const s = summarize(row);
  assert.strictEqual(s.planned_minutes, 180);
  assert.strictEqual(s.done_minutes, 90);
  assert.strictEqual(s.percent, 50);
  assert.strictEqual(s.blocks_marked, 2);
  assert.strictEqual(s.priorities_done, 1);
  assert.strictEqual(s.first, '09:00');
  assert.strictEqual(s.last, '14:30');
});

test('editing and sending rules', () => {
  const today = '2026-10-31';
  assert.strictEqual(editable('2026-10-31', today, {}), true);
  assert.strictEqual(editable('2026-11-01', today, null), true);
  assert.strictEqual(editable('2026-10-30', today, {}), true);
  assert.strictEqual(editable('2026-10-29', today, {}), false);
  assert.strictEqual(editable('2026-10-31', today, { submitted_at: new Date() }), false);
  assert.match(sendProblem('2026-11-01', today, { blocks: [{}] }), /on the day/);
  assert.match(sendProblem('2026-10-31', today, { blocks: [], priorities: [] }), /at least/);
  assert.strictEqual(sendProblem('2026-10-31', today, { blocks: [{}], priorities: [] }), null);
});
