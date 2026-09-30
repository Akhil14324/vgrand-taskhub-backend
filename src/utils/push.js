const db = require('../db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const FCM_BATCH = 500;
const INVALID_FCM_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * Firebase service account, from either:
 *   FIREBASE_SERVICE_ACCOUNT = the service-account JSON (raw or base64-encoded), or
 *   FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
 */
function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(text);
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // Env files usually store the key with literal "\n" sequences.
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

let messagingInstance; // undefined = not initialised yet, null = unavailable

function getMessaging() {
  if (messagingInstance !== undefined) return messagingInstance;
  messagingInstance = null;
  try {
    const credentials = loadServiceAccount();
    if (!credentials) {
      console.log('[push] Firebase not configured — web push disabled (set FIREBASE_* env vars).');
      return null;
    }
    const admin = require('firebase-admin');
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(credentials) });
    messagingInstance = admin.messaging(app);
    console.log('[push] Firebase Cloud Messaging ready.');
  } catch (err) {
    console.error('[push] Failed to initialise Firebase:', err.message);
  }
  return messagingInstance;
}

function isFcmConfigured() {
  return !!getMessaging();
}

/** FCM data payloads must be a flat map of strings. */
function toStringMap(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

async function sendFcm(tokens, title, body, data) {
  const messaging = getMessaging();
  if (!messaging || tokens.length === 0) return;

  // Data-only message: the service worker (public/sw.js) decides whether to show a system
  // notification or hand it to the open app, so we never get duplicates.
  const payload = toStringMap({ ...data, title, body });
  const invalid = [];

  for (let i = 0; i < tokens.length; i += FCM_BATCH) {
    const batch = tokens.slice(i, i + FCM_BATCH);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        data: payload,
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
        android: { priority: 'high' },
      });
      response.responses.forEach((r, idx) => {
        if (!r.success && r.error && INVALID_FCM_CODES.has(r.error.code)) invalid.push(batch[idx]);
      });
    } catch (err) {
      console.error('[push] FCM send failed:', err.message);
    }
  }
  if (invalid.length) await cleanupInvalidTokens(invalid);
}

async function sendExpo(tokens, title, body, data) {
  if (tokens.length === 0) return;
  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    data,
    sound: 'default',
    priority: 'high',
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await response.json();
    const invalid = [];
    (result.data || []).forEach((ticket, idx) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        invalid.push(messages[idx].to);
      }
    });
    if (invalid.length) await cleanupInvalidTokens(invalid);
    if (result.errors?.length) console.error('[push] Expo errors:', JSON.stringify(result.errors));
  } catch (err) {
    console.error('[push] Error sending Expo notifications:', err.message);
  }
}

/**
 * Send a push notification to every registered device of the given users.
 * `data` is delivered to the app for deep linking (type, conversationId, taskId, ...).
 */
async function sendPushToUsers(userIds, title, body, data = {}) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (ids.length === 0) return;
  try {
    const result = await db.query(
      `SELECT pt.token, pt.provider
       FROM push_tokens pt
       JOIN users u ON u.id = pt.user_id
       WHERE pt.user_id = ANY($1::int[]) AND u.status != 'inactive'`,
      [ids]
    );
    const fcmTokens = result.rows.filter((r) => r.provider === 'fcm').map((r) => r.token);
    const expoTokens = result.rows.filter((r) => r.provider !== 'fcm').map((r) => r.token);
    await Promise.all([
      sendFcm(fcmTokens, title, body, data),
      sendExpo(expoTokens, title, body, data),
    ]);
  } catch (err) {
    console.error('[push] Error sending to users:', err.message);
  }
}

async function sendPushToUser(userId, title, body, data = {}) {
  return sendPushToUsers([userId], title, body, data);
}

/** Kept for backward compatibility with older callers. */
async function sendPushToTokens(tokens, title, body, data = {}) {
  return sendExpo(tokens || [], title, body, data);
}

async function cleanupInvalidTokens(tokens) {
  if (!tokens || tokens.length === 0) return;
  try {
    await db.query('DELETE FROM push_tokens WHERE token = ANY($1)', [tokens]);
  } catch (err) {
    console.error('[push] Error cleaning up invalid tokens:', err.message);
  }
}

module.exports = {
  sendPushToTokens,
  sendPushToUser,
  sendPushToUsers,
  cleanupInvalidTokens,
  isFcmConfigured,
};
