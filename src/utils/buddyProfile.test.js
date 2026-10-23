const test = require('node:test');
const assert = require('node:assert');
const { cleanBuddy } = require('./buddyProfile');

test('cleanBuddy keeps a valid profile', () => {
  assert.deepStrictEqual(cleanBuddy({ name: 'Biscuit', coat: 'rose', hat: 'crown' }), { name: 'Biscuit', coat: 'rose', hat: 'crown' });
});

test('cleanBuddy falls back on bad values and trims the name', () => {
  assert.deepStrictEqual(cleanBuddy({ name: '  <b>Kit  Kat</b>  and way too long a name ', coat: 'neon', hat: 'x' }), { name: 'bKit Katb and wa', coat: 'snow', hat: 'none' });
  assert.deepStrictEqual(cleanBuddy({ name: '   ' }), { name: 'Mochi', coat: 'snow', hat: 'none' });
});

test('cleanBuddy rejects non-objects', () => {
  assert.strictEqual(cleanBuddy('Mochi'), null);
  assert.strictEqual(cleanBuddy([]), null);
  assert.strictEqual(cleanBuddy(null), null);
});
