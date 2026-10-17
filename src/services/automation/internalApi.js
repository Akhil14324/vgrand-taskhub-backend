/**
 * Lets an automation do things through the app's own API as the person who owns it, so every rule that
 * applies to them by hand (who may edit, who needs approval, who gets notified) applies here too.
 * The request goes to this same server over the loopback address with a short-lived token, and carries a
 * per-process secret so the rate limiter does not count an automation's calls against the shared address.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { currentRun } = require('../../utils/automation/bus');

const SECRET = crypto.randomBytes(24).toString('hex');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True for a request this server made to itself on behalf of an automation. */
function isInternal(req) {
  return req.headers['x-th-automation'] === SECRET && LOOPBACK.has(req.socket && req.socket.remoteAddress);
}

/** The chain of automations that led to a request, so events it causes can be traced back (see server.js). */
function chainFromRequest(req) {
  try { const c = JSON.parse(req.headers['x-th-automation-chain'] || 'null'); return c && Array.isArray(c.chain) ? { chain: c.chain.map(Number), depth: Number(c.depth) || 1 } : null; } catch { return null; }
}

/** Calls /api/<path> as `userId`. Returns { status, data }; never throws for an HTTP error status. */
async function callApi(userId, method, path, body) {
  const token = jwt.sign({ id: userId, via: 'automation' }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const port = process.env.PORT || 5000;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-th-automation': SECRET,
      'x-th-automation-chain': JSON.stringify(currentRun() || null),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

/** callApi that turns an error status into a thrown, readable Error. */
async function mustCall(userId, method, path, body) {
  const out = await callApi(userId, method, path, body);
  if (out.status >= 400) throw new Error((out.data && out.data.error) || `That did not work (${out.status})`);
  return out.data;
}

module.exports = { isInternal, chainFromRequest, callApi, mustCall };
