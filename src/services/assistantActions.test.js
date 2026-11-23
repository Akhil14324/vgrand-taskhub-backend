const test = require('node:test');
const assert = require('node:assert');
const { validateAction, isRealDate, isTime, DANGEROUS } = require('./assistantActions');

test('isRealDate accepts only dates that exist', () => {
  assert.ok(isRealDate('2026-11-23'));
  assert.ok(isRealDate('2028-02-29'));
  assert.ok(!isRealDate('2026-02-29'));
  assert.ok(!isRealDate('2026-02-31'));
  assert.ok(!isRealDate('2026-13-01'));
  assert.ok(!isRealDate('tomorrow'));
  assert.ok(!isRealDate('2026-1-5'));
  assert.ok(!isRealDate(20261123));
  assert.ok(!isRealDate(null));
});

test('isTime accepts HH:MM on a 24-hour clock', () => {
  assert.ok(isTime('09:30') && isTime('23:59') && isTime('00:00'));
  assert.ok(!isTime('24:00') && !isTime('9:30') && !isTime('12:60') && !isTime('noon'));
});

test('create_todo is cleaned: trimmed, capped, deduplicated, unknown keys dropped', () => {
  const out = validateAction('create_todo', {
    title: '  Finish   the TODO   frontend ', assignee_username: '@akhil', due_date: '2026-11-27', priority: '2',
    steps: ['Design', ' design ', 'Build', '', 42, null], notes: 'Use the new theme', evil: 'DROP TABLE todos', id: 5,
  });
  assert.deepStrictEqual(out, {
    title: 'Finish the TODO frontend', steps: ['Design', 'Build', '42'], notes: 'Use the new theme',
    assignee_username: 'akhil', due_date: '2026-11-27', priority: 2,
  });
});

test('create_todo needs a title and refuses bad dates, times and priorities instead of dropping them silently', () => {
  assert.throws(() => validateAction('create_todo', { title: '   ' }), /title is empty/);
  assert.throws(() => validateAction('create_todo', {}), /title is empty/);
  assert.throws(() => validateAction('create_todo', { title: 'x', due_date: '2026-02-30' }), /not valid/);
  assert.throws(() => validateAction('create_todo', { title: 'x', due_date: 'next friday' }), /YYYY-MM-DD/);
  assert.throws(() => validateAction('create_todo', { title: 'x', due_time: '25:00' }), /HH:MM/);
  assert.throws(() => validateAction('create_todo', { title: 'x', priority: 9 }), /Priority/);
  assert.deepStrictEqual(validateAction('create_todo', { title: 'x', due_date: '', priority: '' }), { title: 'x', steps: [] });
});

test('steps are capped at 15', () => {
  const steps = Array.from({ length: 40 }, (_, i) => `Step ${i}`);
  assert.strictEqual(validateAction('create_todo', { title: 'x', steps }).steps.length, 15);
  assert.strictEqual(validateAction('add_steps', { id: 3, steps }).steps.length, 15);
});

test('actions on a to-do need a real id', () => {
  for (const tool of ['complete_todo', 'delete_todo']) {
    assert.deepStrictEqual(validateAction(tool, { id: '7' }), { id: 7 });
    assert.throws(() => validateAction(tool, {}), /id is not valid/);
    assert.throws(() => validateAction(tool, { id: 0 }), /id is not valid/);
    assert.throws(() => validateAction(tool, { id: -4 }), /id is not valid/);
    assert.throws(() => validateAction(tool, { id: 1.5 }), /id is not valid/);
    assert.throws(() => validateAction(tool, { id: '1; DROP TABLE todos' }), /id is not valid/);
  }
});

test('the other actions are checked too', () => {
  assert.deepStrictEqual(validateAction('reschedule_todo', { id: 2, due_date: '2026-12-01', due_time: '10:15', x: 1 }), { id: 2, due_date: '2026-12-01', due_time: '10:15' });
  assert.throws(() => validateAction('reschedule_todo', { id: 2 }), /new date/);
  assert.deepStrictEqual(validateAction('assign_todo', { id: 2, username: '@Akhil' }), { id: 2, username: 'Akhil' });
  assert.throws(() => validateAction('assign_todo', { id: 2 }), /Who should/);
  assert.deepStrictEqual(validateAction('add_comment', { id: 2, text: ' hi ' }), { id: 2, text: 'hi' });
  assert.throws(() => validateAction('add_comment', { id: 2, text: ' ' }), /comment is empty/);
  assert.throws(() => validateAction('add_steps', { id: 2, steps: [] }), /at least one step/);
  assert.deepStrictEqual(validateAction('set_priority', { id: 2, priority: '1' }), { id: 2, priority: 1 });
  assert.throws(() => validateAction('set_priority', { id: 2, priority: 5 }), /Priority/);
  assert.throws(() => validateAction('set_priority', { id: 2 }), /Priority/);
});

test('an unknown tool is refused, and non-object input is treated as empty', () => {
  assert.throws(() => validateAction('drop_database', {}), /not something the assistant can do/);
  assert.throws(() => validateAction('complete_todo', 'not an object'), /id is not valid/);
  assert.throws(() => validateAction('complete_todo', null), /id is not valid/);
});

test('deleting is the dangerous action', () => {
  assert.ok(DANGEROUS.has('delete_todo'));
  assert.ok(!DANGEROUS.has('complete_todo'));
});
