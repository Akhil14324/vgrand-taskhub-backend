const test = require('node:test');
const assert = require('node:assert');
const { buildWork, reasonFor } = require('./myWork');

const today = '2026-11-23';
let id = 0;
const todo = (o) => ({ id: ++id, title: `t${id}`, priority: 4, status: 'todo', due_date: null, deadline_date: null, created_at: `2026-11-0${(id % 9) + 1}`, open_blocker_count: 0, depends_on: null, ...o });

test('sections come from each task\'s own dates', () => {
  const open = [
    todo({ due_date: '2026-11-20' }), todo({ due_date: today }), todo({ due_date: '2026-11-25' }),
    todo({ due_date: '2026-12-15' }), todo({}), todo({ status: 'in_progress', due_date: today }),
  ];
  const w = buildWork(open, [todo({ is_done: true })], today);
  assert.deepStrictEqual([w.overdue.length, w.dueToday.length, w.upcoming.length, w.later.length, w.noDeadline.length, w.inProgress.length], [1, 2, 1, 1, 1, 1]);
  assert.strictEqual(w.overdue[0].overdue_days, 3);
});

test('order: overdue, then high priority, then today, tomorrow, later, no date', () => {
  const a = todo({ title: 'none' });
  const b = todo({ title: 'later', due_date: '2026-11-30' });
  const c = todo({ title: 'tomorrow', due_date: '2026-11-24' });
  const d = todo({ title: 'today', due_date: today });
  const e = todo({ title: 'high', priority: 1, due_date: '2026-11-28' });
  const f = todo({ title: 'late', due_date: '2026-11-21' });
  const w = buildWork([a, b, c, d, e, f], [], today);
  assert.strictEqual(w.next.todo.title, 'late');
  const order = [...w.overdue, ...w.dueToday, ...w.upcoming, ...w.noDeadline].map((t) => t.title);
  assert.deepStrictEqual(order, ['late', 'today', 'tomorrow', 'high', 'later', 'none']);
});

test('blocked work is never the next task while something can be done', () => {
  const blocked = todo({ title: 'blocked', due_date: '2026-11-20', status: 'blocked' });
  const ready = todo({ title: 'ready', due_date: today });
  const w = buildWork([blocked, ready], [], today);
  assert.strictEqual(w.next.todo.title, 'ready');
  const dep = todo({ title: 'dep', due_date: '2026-11-20', depends_on: [{ id: 1, is_done: false }] });
  assert.strictEqual(buildWork([dep, ready], [], today).next.todo.title, 'ready');
});

test('reasons and tips use only real numbers', () => {
  assert.match(reasonFor(todo({ due_date: '2026-11-21', priority: 1 }), today), /Overdue by 2 days, and urgent priority/);
  assert.match(reasonFor(todo({ due_date: today, due_time: '15:00' }), today), /Due today at 15:00/);
  const w = buildWork([], [todo({ is_done: true })], today);
  assert.deepStrictEqual(w.tips, ['You have finished your most important tasks for today.']);
  assert.strictEqual(w.next, null);
  assert.deepStrictEqual(buildWork([], [], today).tips, ['Nothing is open. Enjoy the clear list.']);
});
