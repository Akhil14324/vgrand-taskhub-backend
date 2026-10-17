const test = require('node:test');
const assert = require('node:assert');
const { runTask, LIMITS } = require('./runner');

const now = { date: '2026-10-19', tomorrow: '2026-10-20', hm: '09:30', dow: 1, epochMinute: 1 };
const owner = { id: 1, name: 'Akhil' };

/** Runs actions with a fake world that records what was done. */
async function run(actions, { initial = {}, globals = {}, tasks = {} } = {}) {
  const done = [];
  const deps = {
    exec: async (type, p, ctx) => { done.push({ type, p }); if (type === 'find_todos') ctx.setVar('found', ['a', 'b', 'c']); return { note: 'ok' }; },
    loadTask: async (id) => tasks[id] || null,
    sleep: async () => {},
  };
  const out = await runTask({ task: { name: 't', actions }, owner, trigger: 'test', now, globals, initial, deps, api: {} });
  return { out, done };
}

test('if / else if / else picks one branch', async () => {
  const actions = (n) => [
    { type: 'set_var', name: 'n', value: String(n), calculate: true },
    { type: 'if', cond: { left: '%n', op: 'lt', right: '3' } }, { type: 'toast', message: 'low' },
    { type: 'elseif', cond: { left: '%n', op: 'lt', right: '6' } }, { type: 'toast', message: 'mid' },
    { type: 'else' }, { type: 'toast', message: 'high' },
    { type: 'end_if' }, { type: 'toast', message: 'after' },
  ];
  for (const [n, want] of [[1, 'low'], [4, 'mid'], [9, 'high']]) {
    const { done, out } = await run(actions(n));
    assert.strictEqual(out.status, 'ok', out.error);
    assert.deepStrictEqual(done.map((d) => d.p.message), [want, 'after']);
  }
});

test('repeat a number of times and for each item, with break', async () => {
  let r = await run([{ type: 'for', mode: 'count', times: '3', var: 'i' }, { type: 'toast', message: 'n%i' }, { type: 'end_for' }]);
  assert.deepStrictEqual(r.done.map((d) => d.p.message), ['n1', 'n2', 'n3']);
  r = await run([{ type: 'find_todos' }, { type: 'for', mode: 'each', list: '%found', var: 'x' }, { type: 'toast', message: '%x#%x_index' }, { type: 'end_for' }]);
  assert.deepStrictEqual(r.done.filter((d) => d.type === 'toast').map((d) => d.p.message), ['a#1', 'b#2', 'c#3']);
  r = await run([
    { type: 'for', mode: 'count', times: '5', var: 'i' }, { type: 'if', cond: { left: '%i', op: 'eq', right: '3' } }, { type: 'break' }, { type: 'end_if' },
    { type: 'toast', message: '%i' }, { type: 'end_for' }, { type: 'toast', message: 'end' },
  ]);
  assert.deepStrictEqual(r.done.map((d) => d.p.message), ['1', '2', 'end']);
});

test('variables: local, global (UPPERCASE), maths, and what a run changes', async () => {
  const { out, done } = await run([
    { type: 'set_var', name: 'COUNT', value: '%COUNT + 1', calculate: true },
    { type: 'set_var', name: 'msg', value: 'Hello %USER, total %COUNT' },
    { type: 'toast', message: '%msg' },
  ], { globals: { COUNT: '4' } });
  assert.strictEqual(done[0].p.message, 'Hello Akhil, total 5');
  assert.deepStrictEqual(out.globals.set, [['COUNT', '5']]);
});

test('initial variables from the event are readable', async () => {
  const { done } = await run([{ type: 'toast', message: 'Task: %todo_title (%overdue_count late)' }], { initial: { todo_title: 'Pay rent', overdue_count: 2 } });
  assert.strictEqual(done[0].p.message, 'Task: Pay rent (2 late)');
});

test('"Only if", stop, goto and labels', async () => {
  let r = await run([{ type: 'toast', message: 'a', when: '1 > 2' }, { type: 'toast', message: 'b', when: '1 < 2' }]);
  assert.deepStrictEqual(r.done.map((d) => d.p.message), ['b']);
  r = await run([{ type: 'toast', message: 'a' }, { type: 'stop' }, { type: 'toast', message: 'b' }]);
  assert.deepStrictEqual(r.done.map((d) => d.p.message), ['a']);
  assert.strictEqual(r.out.status, 'ok');
  r = await run([{ type: 'goto', name: 'end' }, { type: 'toast', message: 'skipped' }, { type: 'label', name: 'end' }, { type: 'toast', message: 'there' }]);
  assert.deepStrictEqual(r.done.map((d) => d.p.message), ['there']);
});

test('run another task shares globals, passes %par1, and returns a value', async () => {
  const tasks = { 5: { name: 'inner', actions: [{ type: 'toast', message: 'got %par1' }, { type: 'return', value: 'back' }] } };
  const { done, out } = await run([{ type: 'perform_task', task_id: '5', par1: 'hello', into: 'answer' }, { type: 'toast', message: '%answer' }], { tasks });
  assert.strictEqual(out.status, 'ok', out.error);
  assert.deepStrictEqual(done.map((d) => d.p.message), ['got hello', 'back']);
});

test('a task that calls itself is stopped by the depth limit', async () => {
  const tasks = { 1: { name: 'loop', actions: [{ type: 'perform_task', task_id: '1' }] } };
  const { out } = await run([{ type: 'perform_task', task_id: '1' }], { tasks });
  assert.strictEqual(out.status, 'limit');
});

test('an endless jump is stopped by the step limit', async () => {
  const { out } = await run([{ type: 'label', name: 'x' }, { type: 'goto', name: 'x' }]);
  assert.strictEqual(out.status, 'limit');
  assert.ok(out.steps > LIMITS.steps);
});

test('errors are reported with a message, not thrown', async () => {
  const { out } = await run([{ type: 'if', cond: { left: '1', op: 'matches', right: '(a+)+$' } }, { type: 'end_if' }]);
  assert.strictEqual(out.status, 'error');
  assert.match(out.error, /pattern|Condition/i);
});

test('wait is capped per run', async () => {
  const { out } = await run(Array.from({ length: 4 }, () => ({ type: 'wait', seconds: 60 })));
  assert.strictEqual(out.status, 'limit');
});
