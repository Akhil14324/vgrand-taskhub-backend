const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { itemKey, newItems, describeApproval, describeMany, verifySignature, formatAmount } = require('./erpSync');

const item = (over = {}) => ({
  kind: 'PO',
  id: 'po1',
  number: 'VGH-PO061',
  action: 'APPROVE',
  party: 'Lakshmi Steel',
  amount: 240000,
  requestedBy: 'Sita',
  project: { id: 'p1', code: 'VGH', name: 'V Grand Hospital' },
  ...over,
});

test('the same record waiting on a different decision counts as new', () => {
  const seen = new Set([itemKey(item())]);
  assert.deepEqual(newItems([item()], seen), []);
  assert.equal(newItems([item({ action: 'FINALIZE' }), item({ id: 'po2' })], seen).length, 2);
  assert.deepEqual(newItems(undefined, seen), []);
});

test('describes one approval in plain words', () => {
  assert.deepEqual(describeApproval(item()), {
    title: 'PO VGH-PO061 needs your approval',
    body: 'Lakshmi Steel · ₹2,40,000 · V Grand Hospital · from Sita',
  });
  const q = describeApproval(item({ kind: 'QUOTATION', number: 'VGH-Q12', action: 'FINALIZE', party: null, amount: null, requestedBy: null, project: null }));
  assert.equal(q.title, 'Quotation VGH-Q12 is waiting to be finalized');
  assert.equal(q.body, 'Open Approvals in Task Hub');
});

test('summarises several at once', () => {
  const many = [1, 2, 3, 4, 5].map((n) => item({ id: `po${n}`, number: `VGH-PO0${n}` }));
  assert.deepEqual(describeMany(many), {
    title: '5 ERP approvals are waiting on you',
    body: 'VGH-PO01, VGH-PO02, VGH-PO03 and 2 more',
  });
});

test('formats rupees the Indian way and skips empty amounts', () => {
  assert.equal(formatAmount(1234567.4), '₹12,34,567');
  assert.equal(formatAmount(0), null);
  assert.equal(formatAmount(null), null);
});

test('accepts only a fresh, correctly signed nudge', () => {
  const secret = 'shared-secret';
  const now = 1_800_000_000_000;
  const timestamp = String(now - 1000);
  const rawBody = Buffer.from('{"event":"erp.approvals.changed"}');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  assert.equal(verifySignature({ secret, timestamp, signature, rawBody, now }), true);
  assert.equal(verifySignature({ secret: 'other', timestamp, signature, rawBody, now }), false);
  assert.equal(verifySignature({ secret, timestamp, signature, rawBody: Buffer.from('{}'), now }), false);
  assert.equal(verifySignature({ secret, timestamp, signature, rawBody, now: now + 10 * 60 * 1000 }), false);
  assert.equal(verifySignature({ secret, timestamp, signature: 'abc', rawBody, now }), false);
  assert.equal(verifySignature({ secret: '', timestamp, signature, rawBody, now }), false);
});
