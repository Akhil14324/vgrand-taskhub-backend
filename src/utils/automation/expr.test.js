const test = require('node:test');
const assert = require('node:assert');
const { evaluate, interpolate, evalCondition, evalComparison, ExprError } = require('./expr');

const vars = { n: 5, name: 'Ravi', list: ['a', 'b', 'c'], csv: 'x,y', empty: '' };
const lookup = (k) => vars[k];

test('interpolate fills known variables and leaves unknown ones alone', () => {
  assert.strictEqual(interpolate('Hi %name, %n left', lookup), 'Hi Ravi, 5 left');
  assert.strictEqual(interpolate('50% off %nope', lookup), '50% off %nope');
  assert.strictEqual(interpolate('%list(2) of %list(#)', lookup), 'b of 3');
  assert.strictEqual(interpolate('%csv(1)', lookup), 'x');
});

test('arithmetic and precedence', () => {
  assert.strictEqual(evaluate('1 + 2 * 3'), 7);
  assert.strictEqual(evaluate('(1 + 2) * 3'), 9);
  assert.strictEqual(evaluate('%n * 2 + 1', lookup), 11);
  assert.strictEqual(evaluate('10 % 3'), 1);
  assert.strictEqual(evaluate('7%3'), 1);
  assert.strictEqual(evaluate('-%n + 2', lookup), -3);
});

test('text joins with + and compares without caring about case', () => {
  assert.strictEqual(evaluate('"a" + "b"'), 'ab');
  assert.strictEqual(evaluate('"Total: " + %n', lookup), 'Total: 5');
  assert.strictEqual(evaluate('%name == "ravi"', lookup), true);
  assert.strictEqual(evaluate('%n >= 5 && %n < 6', lookup), true);
  assert.strictEqual(evaluate('%n > 9 || !false', lookup), true);
});

test('functions', () => {
  assert.strictEqual(evaluate('upper(%name)', lookup), 'RAVI');
  assert.strictEqual(evaluate('contains(%name, "av")', lookup), true);
  assert.strictEqual(evaluate('round(2.567, 1)'), 2.6);
  assert.strictEqual(evaluate('len(%list)', lookup), 3);
  assert.strictEqual(evaluate('join(%list, "-")', lookup), 'a-b-c');
  assert.strictEqual(evaluate('item(%list, 2)', lookup), 'b');
  assert.strictEqual(evaluate('if(%n > 3, "big", "small")', lookup), 'big');
  assert.strictEqual(evaluate('default(%empty, "none")', lookup), 'none');
  assert.strictEqual(evaluate('regexGet("order #4521", "#([0-9]+)", 1)'), '4521');
  assert.strictEqual(evaluate('"abc123" ~ "^[a-z]+[0-9]+$"'), true);
});

test('a condition that is blank is true; unknown words and functions are rejected', () => {
  assert.strictEqual(evalCondition('', lookup), true);
  assert.throws(() => evaluate('process'), ExprError);
  assert.throws(() => evaluate('require("fs")'), ExprError);
  assert.throws(() => evaluate('constructor("x")'), ExprError);
  assert.throws(() => evaluate('1 +'), ExprError);
  assert.throws(() => evaluate('1 / 0'), ExprError);
  assert.throws(() => evaluate('"never closed'), ExprError);
});

test('limits: long input, deep nesting and risky patterns are refused', () => {
  assert.throws(() => evaluate('1+'.repeat(600) + '1'), ExprError);
  assert.throws(() => evaluate('('.repeat(100) + '1' + ')'.repeat(100)), ExprError);
  assert.throws(() => evaluate('"aaaa" ~ "(a+)+$"'), ExprError);
  assert.throws(() => evaluate('"x" ~ "' + 'a'.repeat(300) + '"'), ExprError);
});

test('the three-box comparison', () => {
  assert.strictEqual(evalComparison({ left: '%n', op: 'gt', right: '3' }, lookup), true);
  assert.strictEqual(evalComparison({ left: '%name', op: 'starts', right: 'ra' }, lookup), true);
  assert.strictEqual(evalComparison({ left: '%empty', op: 'empty' }, lookup), true);
  assert.strictEqual(evalComparison({ left: '%name', op: 'not_contains', right: 'z' }, lookup), true);
  assert.strictEqual(evalComparison({ left: 'Invoice 7', op: 'matches', right: 'invoice [0-9]' }, lookup), true);
  assert.strictEqual(evalComparison({ left: '10', op: 'gt', right: '9' }, lookup), true); // numbers, not text
});
