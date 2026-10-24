const crypto = require('crypto');

// Pure helpers for the Hospital ERP approvals link (services/erpApprovals.js). Unit-tested.

const KIND_LABELS = {
  MPR: 'Material request',
  QUOTATION: 'Quotation',
  PO: 'PO',
  INVOICE: 'Invoice',
  PAYMENT: 'Payment',
  GRN: 'Goods receipt',
};

/** One ERP approval as the person sees it: the same record waiting on a different decision is a new item. */
function itemKey(item) {
  return `${item.kind}:${item.id}:${item.action}`;
}

/** Items not in `seen` (a Set of itemKey values). */
function newItems(items, seen) {
  return (items || []).filter((item) => !seen.has(itemKey(item)));
}

function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** Notification text for one approval: "PO VGH-PO061 needs your approval" / "Lakshmi Steel · ₹2,40,000 · V Grand". */
function describeApproval(item) {
  const label = KIND_LABELS[item.kind] || item.kind;
  const title = item.action === 'FINALIZE'
    ? `${label} ${item.number} is waiting to be finalized`
    : `${label} ${item.number} needs your approval`;
  const body = [
    item.party,
    formatAmount(item.amount),
    item.project?.name,
    item.requestedBy ? `from ${item.requestedBy}` : null,
  ].filter(Boolean).join(' · ');
  return { title, body: body || 'Open Approvals in Task Hub' };
}

/** One notification for several new approvals at once. */
function describeMany(items) {
  const numbers = items.slice(0, 3).map((i) => i.number).join(', ');
  return {
    title: `${items.length} ERP approvals are waiting on you`,
    body: items.length > 3 ? `${numbers} and ${items.length - 3} more` : numbers,
  };
}

const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Checks the ERP's "approvals changed" call: hex HMAC-SHA256 of `${timestamp}.${rawBody}`
 * keyed by the shared secret, sent no more than 5 minutes ago.
 */
function verifySignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret || !timestamp || !signature || !rawBody) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  const given = String(signature);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

module.exports = { KIND_LABELS, itemKey, newItems, formatAmount, describeApproval, describeMany, verifySignature };
