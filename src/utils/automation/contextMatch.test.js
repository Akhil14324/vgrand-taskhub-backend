const test = require('node:test');
const assert = require('node:assert');
const { timeSlot, inTimeRange, stateHolds, todoFits, eventFits, contextTypesFor, metres } = require('./contextMatch');

const at = (hm, dow = 1, date = '2026-10-19', epochMinute = 100) => ({ hm, dow, date, epochMinute });

test('time of day fires once, within a few minutes, on the chosen days', () => {
  const ctx = { type: 'time_at', at: '09:00', days: [1, 2, 3, 4, 5] };
  assert.strictEqual(timeSlot(ctx, at('09:00'), null), '2026-10-19T09:00');
  assert.strictEqual(timeSlot(ctx, at('09:02'), null), '2026-10-19T09:00');
  assert.strictEqual(timeSlot(ctx, at('09:00'), '2026-10-19T09:00'), null);
  assert.strictEqual(timeSlot(ctx, at('08:59'), null), null);
  assert.strictEqual(timeSlot(ctx, at('09:10'), null), null);
  assert.strictEqual(timeSlot(ctx, at('09:00', 0), null), null); // Sunday
});

test('interval respects the window and the step', () => {
  const ctx = { type: 'interval', every: 30, from: '09:00', to: '17:00', days: [] };
  assert.ok(timeSlot(ctx, at('10:00', 3, '2026-10-21', 60), null));
  assert.strictEqual(timeSlot(ctx, at('10:00', 3, '2026-10-21', 61), null), null);
  assert.strictEqual(timeSlot(ctx, at('08:00', 3, '2026-10-21', 60), null), null);
});

test('a date context fires on that day only', () => {
  const ctx = { type: 'date_on', date: '2026-12-25', at: '08:00' };
  assert.ok(timeSlot(ctx, at('08:01', 5, '2026-12-25'), null));
  assert.strictEqual(timeSlot(ctx, at('08:01', 5, '2026-12-24'), null), null);
});

test('between two times, including past midnight', () => {
  assert.strictEqual(inTimeRange({ from: '09:00', to: '18:00', days: [] }, at('12:00')), true);
  assert.strictEqual(inTimeRange({ from: '09:00', to: '18:00', days: [] }, at('18:00')), false);
  assert.strictEqual(inTimeRange({ from: '22:00', to: '06:00', days: [] }, at('23:30')), true);
  assert.strictEqual(inTimeRange({ from: '22:00', to: '06:00', days: [] }, at('05:00')), true);
  assert.strictEqual(inTimeRange({ from: '22:00', to: '06:00', days: [] }, at('12:00')), false);
});

test('state contexts', () => {
  const facts = { now: at('10:00'), overdue: 4, todayCount: 2, appOpen: true, device: { battery: 15, charging: false, online: false, lat: 17.385, lon: 78.4867 }, globals: { MODE: 'work' } };
  assert.strictEqual(stateHolds({ type: 'overdue_count', min: 3 }, facts), true);
  assert.strictEqual(stateHolds({ type: 'overdue_count', min: 5 }, facts), false);
  assert.strictEqual(stateHolds({ type: 'open_today_count', cmp: 'le', n: 2 }, facts), true);
  assert.strictEqual(stateHolds({ type: 'battery', cmp: 'le', percent: 20, charging: 'no' }, facts), true);
  assert.strictEqual(stateHolds({ type: 'battery', cmp: 'le', percent: 20, charging: 'yes' }, facts), false);
  assert.strictEqual(stateHolds({ type: 'online', is: 'offline' }, facts), true);
  assert.strictEqual(stateHolds({ type: 'app_open', is: 'open' }, facts), true);
  assert.strictEqual(stateHolds({ type: 'place', lat: 17.3851, lon: 78.4868, radius: 150, is: 'inside' }, facts), true);
  assert.strictEqual(stateHolds({ type: 'place', lat: 28.6, lon: 77.2, radius: 150, is: 'inside' }, facts), false);
  assert.strictEqual(stateHolds({ type: 'variable', cond: { left: '%MODE', op: 'eq', right: 'work' } }, facts), true);
});

test('unknown device readings never count as true', () => {
  const facts = { now: at('10:00'), device: {} };
  for (const ctx of [{ type: 'battery', cmp: 'le', percent: 99, charging: 'any' }, { type: 'online', is: 'offline' }, { type: 'place', lat: 1, lon: 1, radius: 100, is: 'outside' }]) {
    assert.strictEqual(stateHolds(ctx, facts), false, ctx.type);
  }
});

test('to-do filters', () => {
  const todo = { id: 7, title: 'Pay the Invoice', business_id: 3, assignee_id: 9, created_by: 2, labels: ['finance'], members: [{ id: 9 }] };
  assert.strictEqual(todoFits({ scope: 'any' }, todo, 1), true);
  assert.strictEqual(todoFits({ scope: 'mine' }, todo, 9), true);
  assert.strictEqual(todoFits({ scope: 'mine' }, todo, 1), false);
  assert.strictEqual(todoFits({ scope: 'business', business_id: 3 }, todo, 1), true);
  assert.strictEqual(todoFits({ scope: 'business', business_id: 4 }, todo, 1), false);
  assert.strictEqual(todoFits({ text: 'invoice' }, todo, 1), true);
  assert.strictEqual(todoFits({ label: 'finance' }, todo, 1), true);
  assert.strictEqual(todoFits({ label: 'ops' }, todo, 1), false);
});

test('event kinds map to contexts, and status / priority / assignment are checked', () => {
  assert.deepStrictEqual(contextTypesFor('completed'), ['todo_completed', 'todo_changed']);
  assert.deepStrictEqual(contextTypesFor('created'), ['todo_created']);
  assert.strictEqual(eventFits({ type: 'todo_status', to: 'blocked' }, { to: 'blocked' }, 1), true);
  assert.strictEqual(eventFits({ type: 'todo_status', to: 'blocked' }, { to: 'done' }, 1), false);
  assert.strictEqual(eventFits({ type: 'todo_priority', to: '1' }, { to: 'P1' }, 1), true);
  assert.strictEqual(eventFits({ type: 'todo_assigned' }, { subjectId: 5, to: 'Me' }, 5), true);
  assert.strictEqual(eventFits({ type: 'todo_assigned' }, { subjectId: 5, to: null }, 5), false);
  assert.ok(metres(0, 0, 0, 1) > 100000);
});
