const db = require('../db');
const { notify, emitToUsers } = require('../utils/notify');
const { itemKey, newItems, describeApproval, describeMany, verifySignature } = require('../utils/erpSync');

/**
 * Hospital ERP approvals in Task Hub.
 *
 * The ERP (its own backend + database) owns the approvals; this only reads them for the people who linked
 * their ERP account, and tells them when a new one arrives. Nothing is copied into this database.
 *
 * - Link: the person makes a 6-digit code in the ERP (Settings → Task Hub) and types it here; the ERP says
 *   whose code it was and we keep that ERP user id in `users.preferences.erp` (no new column or table; the
 *   preferences endpoint only writes whitelisted keys, so a person cannot set or change it themselves).
 * - Read: GET {ERP_API_URL}/integrations/taskhub/approvals?erpUserId=… with the shared secret, cached a minute.
 * - Notify: the ERP POSTs a signed "approvals changed" to /api/erp/webhook (and a 10-minute job re-checks
 *   in case one is missed); we re-read every linked person and notify only items they were not told about.
 *   What each person was told about is kept in memory: after a restart the first read is taken as known.
 *
 * Env: ERP_API_URL (the ERP API base, ending in /api), TASKHUB_SYNC_SECRET (same value on both servers).
 */

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 1000;
/** More new items than this at once become one summary notification. */
const MAX_SINGLE_NOTICES = 3;

const erpBase = () => (process.env.ERP_API_URL || '').trim().replace(/\/+$/, '');
const syncSecret = () => (process.env.TASKHUB_SYNC_SECRET || '').trim();
const isConfigured = () => !!erpBase() && !!syncSecret();

class ErpError extends Error {
  constructor(message, status, code) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

async function erpCall(method, path, body) {
  let res;
  try {
    res = await fetch(`${erpBase()}/integrations/taskhub${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-taskhub-secret': syncSecret() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ErpError('Could not reach the Hospital ERP', 502, 'ERP_UNREACHABLE');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A refused secret is our misconfiguration, not the person's fault.
    const status = res.status === 400 || res.status === 403 ? res.status : 502;
    throw new ErpError(data.error || `The Hospital ERP answered ${res.status}`, status, data.code || 'ERP_ERROR');
  }
  return data;
}

// ── the link, kept in users.preferences.erp ──────────────────

async function linkOf(userId) {
  const r = await db.query(`SELECT preferences->'erp' AS erp FROM users WHERE id = $1`, [userId]);
  const erp = r.rows[0]?.erp;
  return erp && erp.userId ? erp : null;
}

async function linkedPeople() {
  const r = await db.query(
    `SELECT id, preferences->'erp' AS erp FROM users
     WHERE preferences->'erp'->>'userId' IS NOT NULL AND COALESCE(status, 'active') <> 'inactive'`
  );
  return r.rows;
}

async function saveLink(userId, erp) {
  // One ERP account belongs to one Task Hub person: linking it here unlinks it anywhere else.
  await db.query(
    `UPDATE users SET preferences = preferences - 'erp' WHERE id <> $1 AND preferences->'erp'->>'userId' = $2`,
    [userId, erp.userId]
  );
  await db.query(
    `UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object('erp', $2::jsonb) WHERE id = $1`,
    [userId, JSON.stringify(erp)]
  );
}

async function clearLink(userId) {
  await db.query(`UPDATE users SET preferences = preferences - 'erp' WHERE id = $1`, [userId]);
  cache.delete(userId);
  seen.delete(userId);
}

// ── reading ─────────────────────────────────────────────────

const cache = new Map(); // task hub user id -> { at, data }
const seen = new Map(); // task hub user id -> Set of itemKey already told about

/** Fresh list for one linked person; unlinks them when the ERP account is gone. */
async function fetchFor(userId, erp) {
  const data = await erpCall('GET', `/approvals?erpUserId=${encodeURIComponent(erp.userId)}`);
  if (!data.user) {
    await clearLink(userId);
    return null;
  }
  const value = { erpUser: data.user, eligible: !!data.eligible, items: data.items || [], generatedAt: data.generatedAt };
  cache.set(userId, { at: Date.now(), data: value });
  if (!seen.has(userId)) seen.set(userId, new Set(value.items.map(itemKey)));
  return value;
}

/** What the Approvals screen shows. */
async function getApprovals(userId, { fresh = false } = {}) {
  if (!isConfigured()) return { configured: false, linked: false, items: [] };
  const erp = await linkOf(userId);
  if (!erp) return { configured: true, linked: false, items: [] };
  const hit = cache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return { configured: true, linked: true, ...hit.data };
  try {
    const value = await fetchFor(userId, erp);
    if (!value) return { configured: true, linked: false, items: [], unlinkedReason: 'erp_user_gone' };
    return { configured: true, linked: true, ...value };
  } catch (err) {
    // The ERP being down must not break the Approvals screen: show the last list we had, with a note.
    return {
      configured: true,
      linked: true,
      erpUser: hit?.data.erpUser || { name: erp.name, roleLabel: erp.roleLabel },
      eligible: hit ? hit.data.eligible : true,
      items: hit?.data.items || [],
      generatedAt: hit?.data.generatedAt || null,
      error: err.message,
    };
  }
}

/** Last known ERP count for the Approvals badge; never calls the ERP. */
function cachedCount(userId) {
  const hit = cache.get(userId);
  return hit && hit.data.eligible ? hit.data.items.length : 0;
}

async function link(userId, code) {
  if (!isConfigured()) throw new ErpError('The Hospital ERP is not connected to Task Hub yet', 503, 'ERP_NOT_CONFIGURED');
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) throw new ErpError('Type the 6-digit code from the ERP', 400, 'CODE_INVALID');
  const { user } = await erpCall('POST', '/link', { code: clean });
  await saveLink(userId, { userId: user.id, name: user.name, role: user.role, roleLabel: user.roleLabel, linkedAt: new Date().toISOString() });
  cache.delete(userId);
  seen.delete(userId);
  return getApprovals(userId, { fresh: true });
}

// ── keeping people told ─────────────────────────────────────

async function tell(userId, fresh) {
  if (!fresh.length) return;
  if (fresh.length > MAX_SINGLE_NOTICES) {
    const { title, body } = describeMany(fresh);
    await notify([userId], { type: 'erp_approval', title, body, data: { erp: '1' } });
    return;
  }
  for (const item of fresh) {
    const { title, body } = describeApproval(item);
    await notify([userId], { type: 'erp_approval', title, body, data: { erp: '1', url: item.url } });
  }
}

let running = null;
let again = false;

/** Re-read every linked person and notify what is new to them. One run at a time; asks made meanwhile run once after. */
function syncAll() {
  if (!isConfigured()) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      for (const { id, erp } of await linkedPeople()) {
        try {
          const before = seen.get(id);
          const prevKeys = (cache.get(id)?.data.items || []).map(itemKey).sort().join('|');
          const value = await fetchFor(id, erp);
          if (!value) {
            emitToUsers([id], 'erp:approvals', { count: 0 });
            continue;
          }
          const items = value.eligible ? value.items : [];
          if (before) {
            await tell(id, newItems(items, before));
            seen.set(id, new Set(items.map(itemKey)));
          }
          // Open apps reload the list and the badge, only when the list really changed.
          if (items.map(itemKey).sort().join('|') !== prevKeys) emitToUsers([id], 'erp:approvals', { count: items.length });
        } catch (err) {
          console.error('[erp] sync failed for user', id, err.message);
        }
      }
    } catch (err) {
      console.error('[erp] sync failed:', err.message);
    } finally {
      running = null;
      if (again) {
        again = false;
        syncAll();
      }
    }
  })();
  return running;
}

/** Checks a webhook call from the ERP against the raw body express kept. */
function isValidNudge(req) {
  return verifySignature({
    secret: syncSecret(),
    timestamp: req.headers['x-erp-timestamp'],
    signature: req.headers['x-erp-signature'],
    rawBody: req.rawBody,
  });
}

module.exports = { isConfigured, getApprovals, cachedCount, link, clearLink, syncAll, isValidNudge, ErpError };
