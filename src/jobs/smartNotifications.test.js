const test = require('node:test');
const assert = require('node:assert');
const { dueLeads, leadText } = require('./smartNotifications');

const MIN = 60000;
const due = 1_000_000_000_000;

test('a lead is due only inside its own window', () => {
  const all = [1440, 180, 30];
  assert.deepStrictEqual(dueLeads(due, all, due - 1440 * MIN + 5 * MIN), [1440]);
  assert.deepStrictEqual(dueLeads(due, all, due - 180 * MIN + 5 * MIN), [180]);
  assert.deepStrictEqual(dueLeads(due, all, due - 30 * MIN + MIN), [30]);
  assert.deepStrictEqual(dueLeads(due, all, due - 600 * MIN), []); // between windows: nothing
});

test('a missed reminder is not sent long after its moment, nor after the deadline', () => {
  assert.deepStrictEqual(dueLeads(due, [1440], due - 1440 * MIN + 7 * 60 * MIN), []); // 7 h late
  assert.deepStrictEqual(dueLeads(due, [30], due + MIN), []); // already due
});

test('only the reminder times a person chose are used', () => {
  assert.deepStrictEqual(dueLeads(due, [1440], due - 30 * MIN + MIN), []);
  assert.deepStrictEqual(dueLeads(due, [], due - 30 * MIN + MIN), []);
});

test('lead texts name the task', () => {
  assert.strictEqual(leadText('TODO app changes', 1440, null), "Reminder: Your task 'TODO app changes' is due tomorrow.");
  assert.match(leadText('X', 180, null), /due in 3 hours/);
  assert.match(leadText('X', 30, null), /due in 30 minutes/);
});
