const test = require('node:test');
const assert = require('node:assert');
const { categoryOf, cleanNotifPrefs, inQuietHours, settingsOf, decide } = require('./notificationPrefs');

test('categoryOf maps known types and treats the rest as team updates', () => {
  assert.strictEqual(categoryOf('todo_reminder'), 'reminders');
  assert.strictEqual(categoryOf('todo_assigned'), 'assignments');
  assert.strictEqual(categoryOf('overdue'), 'overdue');
  assert.strictEqual(categoryOf('mention'), 'team');
});

test('cleanNotifPrefs keeps valid values only', () => {
  assert.deepStrictEqual(cleanNotifPrefs({ reminders: false, quietStart: 23, quietEnd: 99, delivery: 'sms', hacker: 1 }), { reminders: false, quietStart: 23 });
  assert.strictEqual(cleanNotifPrefs(null), null);
  assert.strictEqual(cleanNotifPrefs([]), null);
});

test('quiet hours cross midnight and are off unless enabled', () => {
  const s = settingsOf({ notifications: { quietEnabled: true, quietStart: 22, quietEnd: 7 } });
  assert.ok(inQuietHours(s, 23));
  assert.ok(inQuietHours(s, 3));
  assert.ok(!inQuietHours(s, 12));
  assert.ok(!inQuietHours(settingsOf({}), 23));
});

test('decide drops switched-off categories and silences quiet hours and in-app only', () => {
  assert.deepStrictEqual(decide({ notifications: { reminders: false } }, 'todo_reminder', 12), { send: false });
  assert.deepStrictEqual(decide({ notifications: { reminders: false } }, 'mention', 12), { send: true, live: true, push: true });
  assert.deepStrictEqual(decide({}, 'todo_assigned', 12), { send: true, live: true, push: true });
  assert.deepStrictEqual(decide({ notifications: { quietEnabled: true } }, 'todo_assigned', 23), { send: true, live: false, push: false });
  assert.deepStrictEqual(decide({ notifications: { delivery: 'in_app' } }, 'todo_assigned', 12), { send: true, live: true, push: false });
  assert.deepStrictEqual(decide({ notifications: { deadlines: false } }, 'overdue', 12), { send: false });
});

test('leads keep only the offered reminder times, in order', () => {
  assert.deepStrictEqual(cleanNotifPrefs({ leads: [30, 7, 1440] }), { leads: [1440, 30] });
  assert.deepStrictEqual(cleanNotifPrefs({ leads: [] }), { leads: [] });
  assert.deepStrictEqual(settingsOf({}).leads, [1440, 180, 30]);
});
