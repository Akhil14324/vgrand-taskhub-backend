const test = require('node:test');
const assert = require('node:assert');
const { decorateTodo } = require('./todoAccess');
const { worksIn } = require('../utils/org');

// A business task as TODO_SELECT returns it, created by a business head (level 4) in business 1.
const task = (extra = {}) => ({
  id: 1, business_id: 1, created_by: 100, assignee_id: 101, review_state: 'accepted', status: 'todo',
  is_done: false, _creator_role: 'user', _creator_org_level: null, _creator_designation: 'head',
  _assignee_role: 'user', _assignee_org_level: null, _assignee_designation: 'member', ...extra,
});
const person = (id, memberships, global = null) => ({ id, global, memberships: new Map(memberships) });

test('anyone in the business can assign its tasks (open assignment)', () => {
  const cashier = person(200, [[1, 'member']]);
  assert.strictEqual(decorateTodo(task(), cashier).permissions.can_assign, true);
});

test('someone from another business cannot assign them', () => {
  const outsider = person(300, [[2, 'head']]);
  assert.strictEqual(decorateTodo(task(), outsider).permissions.can_assign, false);
});

test('leadership can assign in any business', () => {
  assert.strictEqual(decorateTodo(task(), person(2, [], 1)).permissions.can_assign, true);
});

test('a declined proposal cannot be reassigned by members', () => {
  const member = person(200, [[1, 'member']]);
  assert.strictEqual(decorateTodo(task({ review_state: 'rejected' }), member).permissions.can_assign, false);
});

test('open assignment does not loosen editing or deleting someone else\'s task', () => {
  const member = person(200, [[1, 'member']]);
  const p = decorateTodo(task(), member).permissions;
  assert.strictEqual(p.can_edit, false);
  assert.strictEqual(p.can_delete, false);
});

test('the assignee can edit the task and tick it, but not delete it', () => {
  const assignee = person(101, [[1, 'member']]);
  const p = decorateTodo(task(), assignee).permissions;
  assert.strictEqual(p.can_edit, true);
  assert.strictEqual(p.can_change_status, true);
  assert.strictEqual(p.can_delete, false);
});

test('the assignee can decline a business task someone else gave them, nobody else can', () => {
  const assignee = person(101, [[1, 'member']]);
  assert.strictEqual(decorateTodo(task({ assigned_by_id: 100 }), assignee).permissions.can_decline, true);
  // Their own task (they gave it to themselves), a finished one, and a person who is not the assignee: nothing to decline.
  assert.strictEqual(decorateTodo(task({ assigned_by_id: 101 }), assignee).permissions.can_decline, false);
  assert.strictEqual(decorateTodo(task({ assigned_by_id: 100, is_done: true }), assignee).permissions.can_decline, false);
  assert.strictEqual(decorateTodo(task({ assigned_by_id: 100 }), person(200, [[1, 'member']])).permissions.can_decline, false);
});

test('a task that was declined back to me cannot be declined again until I deal with it', () => {
  const me = person(101, [[1, 'member']]);
  const back = task({ assigned_by_id: 100, declined_at: '2026-11-26T10:00:00Z', declined_giver: 101 });
  assert.strictEqual(decorateTodo(back, me).permissions.can_decline, false);
});

test('worksIn: members and leadership add accepted tasks, outsiders propose', () => {
  assert.strictEqual(worksIn(person(200, [[1, 'member']]), 1), true);
  assert.strictEqual(worksIn(person(2, [], 1), 5), true);
  assert.strictEqual(worksIn(person(300, [[2, 'head']]), 1), false);
});
