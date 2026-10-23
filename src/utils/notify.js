const db = require('../db');
const { sendPushToUsers } = require('./push');
const { publish } = require('./automation/bus');
const { currentActorId } = require('./actorContext');
const { cleanBuddy } = require('./buddyProfile');

let ioRef = null;

/** Called once from server.js so routes can emit realtime events without req.app. */
function setIO(io) {
  ioRef = io;
}

function getIO() {
  return ioRef;
}

function uniqueIds(ids, exclude = []) {
  const skip = new Set((exclude || []).map(Number));
  return [...new Set((ids || []).map(Number).filter((id) => id && !skip.has(id)))];
}

/** Emit a socket event to the personal rooms of the given users. */
function emitToUsers(userIds, event, payload) {
  if (!ioRef) return;
  for (const id of uniqueIds(userIds)) ioRef.to(`user:${id}`).emit(event, payload);
  if (event === 'todo:changed' && payload && payload.action === 'commented') {
    publish('todo_event', { todoId: payload.todoId, kind: 'comment', audience: uniqueIds(userIds) });
  }
}

const profileCache = new Map(); // id -> { at, value }

/** A person's name and cat (null when they switched their cat buddy off). Cached for a minute. */
async function catOf(userId) {
  const hit = profileCache.get(userId);
  if (hit && Date.now() - hit.at < 60e3) return hit.value;
  let value = null;
  try {
    const r = await db.query('SELECT name, preferences FROM users WHERE id = $1', [userId]);
    const row = r.rows[0];
    const prefs = row?.preferences || {};
    if (row && prefs.features?.buddy !== false && prefs.features?.buddy_social !== false) {
      value = { id: userId, name: row.name, buddy: cleanBuddy(prefs.buddy) || cleanBuddy({}) };
    }
  } catch { /* the visit is optional */ }
  profileCache.set(userId, { at: Date.now(), value });
  return value;
}

/**
 * Tell people that someone's cat is coming to see them (the sender's cat walks onto their screen). Fire and
 * forget: it never fails the request that caused it.
 */
async function visit(userIds, fromId, kind, extra = {}) {
  if (!ioRef || !fromId) return;
  const ids = uniqueIds(userIds, [fromId]);
  if (!ids.length) return;
  const from = await catOf(Number(fromId));
  if (!from) return;
  for (const id of ids) ioRef.to(`user:${id}`).emit('buddy:visit', { from, kind, ...extra });
}

/**
 * Notify users: store an in-app notification, push it live over the socket and
 * send a device push (FCM web push / Expo).
 *
 * @param {number[]} userIds
 * @param {{ type: string, title: string, body: string, data?: object }} notification
 * @param {{ store?: boolean, push?: boolean, exclude?: number[] }} options
 *   store=false skips the notifications table (used for chat messages).
 */
async function notify(userIds, { type, title, body, data = {} }, { store = true, push = true, exclude = [] } = {}) {
  const ids = uniqueIds(userIds, exclude);
  if (ids.length === 0) return;
  const actor = currentActorId();
  if (actor) visit(ids, actor, type, { todoId: data.todoId || null, text: String(body || '').slice(0, 90) }).catch(() => {});
  try {
    if (store) {
      const result = await db.query(
        `INSERT INTO notifications (user_id, type, title, message, data)
         SELECT uid, $2, $3, $4, $5 FROM unnest($1::int[]) AS uid
         RETURNING id, user_id, type, title, message, data, is_read, created_at`,
        [ids, type, title || null, body, data]
      );
      if (ioRef) {
        for (const row of result.rows) ioRef.to(`user:${row.user_id}`).emit('notification:new', row);
      }
      for (const row of result.rows) {
        publish('notification', { userId: row.user_id, type: row.type, title: row.title || '', text: row.message || '' });
      }
    }
    if (push) {
      sendPushToUsers(ids, title, body, { type, ...data }).catch(() => {});
    }
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

module.exports = { setIO, getIO, emitToUsers, notify, uniqueIds, visit };
