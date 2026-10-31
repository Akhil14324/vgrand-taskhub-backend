const test = require('node:test');
const assert = require('node:assert');
const { boardAccess, canCreateBoard } = require('./boardAccess');

const person = (id, memberships = [], global = null) => ({ id, global, memberships: new Map(memberships) });
const bizBoard = (extra = {}) => ({ id: 1, scope: 'business', business_id: 1, privacy: 'main', created_by: 9, ...extra });

test('everyone in the business sees and fills its boards; managers shape them', () => {
  const cashier = boardAccess(person(20, [[1, 'member']]), bizBoard());
  assert.deepStrictEqual([cashier.view, cashier.add, cashier.manage], [true, true, false]);
  const head = boardAccess(person(21, [[1, 'head']]), bizBoard());
  assert.deepStrictEqual([head.view, head.add, head.manage], [true, true, true]);
});

test('other businesses cannot see the board; leadership can do everything', () => {
  assert.strictEqual(boardAccess(person(30, [[2, 'head']]), bizBoard()).view, false);
  const leader = boardAccess(person(2, [], 1), bizBoard());
  assert.deepStrictEqual([leader.view, leader.add, leader.manage], [true, true, true]);
});

test('a private board is for its creator, its members and leadership', () => {
  const board = bizBoard({ privacy: 'private' });
  assert.strictEqual(boardAccess(person(20, [[1, 'head']]), board).view, false);
  assert.strictEqual(boardAccess(person(9, [[1, 'member']]), board).manage, true);
  const invited = boardAccess(person(20, [[1, 'member']]), board, [{ user_id: 20, role: 'viewer' }]);
  assert.deepStrictEqual([invited.view, invited.add], [true, false]);
});

test('an invited guest sees only that board', () => {
  const guest = person(40);
  assert.strictEqual(boardAccess(guest, bizBoard()).view, false);
  const access = boardAccess(guest, bizBoard(), [{ user_id: 40, role: 'editor' }]);
  assert.deepStrictEqual([access.view, access.add, access.manage], [true, true, false]);
});

test('personal boards belong to their owner, even against leadership', () => {
  const board = { id: 5, scope: 'personal', owner_id: 20, privacy: 'private' };
  assert.strictEqual(boardAccess(person(20), board).manage, true);
  assert.strictEqual(boardAccess(person(2, [], 1), board).view, false);
});

test('who may create boards where', () => {
  assert.strictEqual(canCreateBoard(person(20, [[1, 'member']]), 'business', 1), true);
  assert.strictEqual(canCreateBoard(person(20, [[1, 'member']]), 'business', 2), false);
  assert.strictEqual(canCreateBoard(person(20), 'group'), false);
  assert.strictEqual(canCreateBoard(person(2, [], 2), 'group'), true);
  assert.strictEqual(canCreateBoard(person(20), 'personal'), true);
});
