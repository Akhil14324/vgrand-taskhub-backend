const test = require('node:test');
const assert = require('node:assert');
const { cleanContexts, cleanTask, analyzeBlocks, RECIPES, CONTEXTS, ACTIONS, publicCatalog } = require('./catalog');

test('every recipe is valid as shipped', () => {
  for (const r of RECIPES) {
    const ctx = cleanContexts(r.profile.contexts);
    assert.deepStrictEqual(ctx.errors, [], `${r.id} contexts`);
    for (const slot of ['enter', 'exit']) {
      if (!r[slot]) continue;
      const out = cleanTask(r[slot].actions, { canUseWeb: false });
      assert.deepStrictEqual(out.errors, [], `${r.id} ${slot}`);
    }
  }
});

test('every context and action has a label and a group, and fields that the editor knows', () => {
  const types = new Set(['text', 'textarea', 'number', 'select', 'bool', 'time', 'days', 'date', 'person', 'business', 'task', 'priority', 'status', 'label', 'cond', 'expr']);
  for (const [name, spec] of [...Object.entries(CONTEXTS), ...Object.entries(ACTIONS)]) {
    assert.ok(spec.label && spec.group, name);
    for (const f of spec.fields) assert.ok(types.has(f.type), `${name}.${f.key} has type ${f.type}`);
  }
  assert.ok(publicCatalog().recipes.length >= 8);
});

test('a profile has at most one event, and at least one context', () => {
  assert.ok(cleanContexts([]).errors.length);
  assert.ok(cleanContexts([{ type: 'time_at', at: '09:00' }, { type: 'todo_created' }]).errors.length);
  assert.deepStrictEqual(cleanContexts([{ type: 'time_at', at: '09:00' }, { type: 'battery' }]).errors, []);
  assert.ok(cleanContexts([{ type: 'nope' }]).errors.length);
});

test('block structure is checked', () => {
  const ok = [{ type: 'if' }, { type: 'elseif' }, { type: 'else' }, { type: 'end_if' }, { type: 'for' }, { type: 'break' }, { type: 'end_for' }];
  assert.deepStrictEqual(analyzeBlocks(ok).errors, []);
  assert.ok(analyzeBlocks([{ type: 'if' }]).errors.length);
  assert.ok(analyzeBlocks([{ type: 'end_if' }]).errors.length);
  assert.ok(analyzeBlocks([{ type: 'else' }]).errors.length);
  assert.ok(analyzeBlocks([{ type: 'break' }]).errors.length);
  assert.ok(analyzeBlocks([{ type: 'if' }, { type: 'else' }, { type: 'else' }, { type: 'end_if' }]).errors.length);
});

test('cleanTask drops unknown fields, enforces required ones and the web permission', () => {
  const out = cleanTask([{ type: 'notify_me', title: 'Hi', message: 'There', evil: '<script>' }], { canUseWeb: false });
  assert.deepStrictEqual(out.errors, []);
  assert.strictEqual(out.actions[0].evil, undefined);
  assert.ok(cleanTask([{ type: 'notify_me', title: 'Hi', message: '' }]).errors.length);
  assert.ok(cleanTask([{ type: 'http_request', url: 'https://x.y' }], { canUseWeb: false }).errors.length);
  assert.deepStrictEqual(cleanTask([{ type: 'http_request', url: 'https://x.y' }], { canUseWeb: true }).errors, []);
  assert.ok(cleanTask([{ type: 'goto', name: 'missing' }]).errors.length);
  assert.ok(cleanTask([{ type: 'set_var', name: 'a', value: '1 +', calculate: true }]).errors.length);
  assert.ok(cleanTask([{ type: 'stop', when: 'badword' }]).errors.length);
  assert.ok(cleanTask(Array.from({ length: 70 }, () => ({ type: 'stop' }))).errors.length);
});
