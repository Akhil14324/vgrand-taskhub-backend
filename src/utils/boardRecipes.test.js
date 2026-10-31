const test = require('node:test');
const assert = require('node:assert');
const { BOARD_RECIPES, buildRecipe, isBoardProfile } = require('./boardRecipes');
const catalog = require('./automation/catalog');

const board = { id: 12, name: 'Tripura construction' };

test('every board recipe builds a profile and task the automation catalog accepts', () => {
  for (const r of BOARD_RECIPES) {
    const built = buildRecipe(r.id, board, { person: '8', status: 'done', at: '08:30' });
    assert.ok(!built.error, r.id);
    const ctx = catalog.cleanContexts(built.profile.contexts);
    assert.deepStrictEqual(ctx.errors, [], r.id);
    const task = catalog.cleanTask({ name: built.tasks.enter.name, actions: built.tasks.enter.actions });
    assert.deepStrictEqual(task.errors || [], [], r.id);
  }
});

test('board-limited contexts keep the board after cleaning', () => {
  const built = buildRecipe('done-notify', board);
  const { contexts } = catalog.cleanContexts(built.profile.contexts);
  assert.strictEqual(contexts[0].scope, 'board');
  assert.strictEqual(String(contexts[0].board_id), '12');
  assert.strictEqual(isBoardProfile(contexts, 12), true);
  assert.strictEqual(isBoardProfile(contexts, 13), false);
});

test('a recipe that needs a person says so', () => {
  assert.match(buildRecipe('new-item-assign', board, {}).error, /person/);
  assert.match(buildRecipe('nope', board).error, /Unknown/);
});
