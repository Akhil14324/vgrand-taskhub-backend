const test = require('node:test');
const assert = require('node:assert/strict');
const { splitText } = require('./transcript');

test('short text stays in one part', () => {
  assert.deepEqual(splitText('hello there', 100), ['hello there']);
});

test('long text is cut at line ends and nothing is lost', () => {
  const line = 'a'.repeat(40);
  const text = Array.from({ length: 30 }, () => line).join('\n');
  const parts = splitText(text, 200);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.equal(parts.join('\n').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('text with no line ends is still cut', () => {
  const parts = splitText('x'.repeat(500), 120);
  assert.ok(parts.every((p) => p.length <= 120));
  assert.equal(parts.join('').length, 500);
});
