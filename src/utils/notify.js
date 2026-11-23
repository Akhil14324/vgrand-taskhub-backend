const db = require('../db');
const { sendPushToUsers } = require('./push');
const { publish } = require('./automation/bus');
const { APP_TIMEZONE } = require('./recurrence');
const { decide } = require('./notificationPrefs');

let ioRef = null;

/** Called once from server.js so routes can emit realtime events without req.app. */
function setIO(io) {
  ioRef = io;
}

function getIO() {
  return ioRef;
}

/** The hour (0-23) it is now in the company timezone, for quiet hours. */
function currentHour() {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: APP_TIMEZONE }).format(new Date());
  return Number(h) % 24;
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

/**
 * Notify users: store an in-app notification, push it live over the socket and
 * send a device push (FCM web push / Expo).
 *
 * @param {number[]} userIds
 * @param {{ type: string, title: string, body: string, data?: object }} notification
 * @param {{ store?: boolean, push?: boolean, exclude?: number[] }} options
 *   store=false skips the notifications table (used for chat messages).
 */
async function notify(userIds, { type, title, body, data = {} }, { store = true, push = true, exclude = [], eventKey = null } = {}) {
  const ids = uniqueIds(userIds, exclude);
  if (ids.length === 0) return;
  try {
    // Each person's own settings decide: a category they switched off is dropped for them, quiet hours and
    // "in-app only" keep it silent (stored, but no live pop-up, sound or device push).
    const hourNow = currentHour();
    let prefsById = new Map();
    try {
      const rows = (await db.query('SELECT id, preferences FROM users WHERE id = ANY($1::int[])', [ids])).rows;
      prefsById = new Map(rows.map((r) => [r.id, r.preferences]));
    } catch { /* settings unavailable: deliver as before */ }
    const sendTo = [];
    const liveTo = new Set();
    const pushTo = [];
    for (const id of ids) {
      const d = decide(prefsById.get(id), type, hourNow);
      if (!d.send) continue;
      sendTo.push(id);
      if (d.live) liveTo.add(id);
      if (d.push) pushTo.push(id);
    }
    if (sendTo.length === 0) return;
    if (store) {
      const result = await db.query(
        `INSERT INTO notifications (user_id, type, title, message, data, event_key)
         SELECT uid, $2, $3, $4, $5, $6 FROM unnest($1::int[]) AS uid
         ON CONFLICT DO NOTHING
         RETURNING id, user_id, type, title, message, data, is_read, created_at`,
        [sendTo, type, title || null, body, data, eventKey ? String(eventKey).slice(0, 160) : null]
      );
      // With an event key a repeat is refused by the database: only people who really got a new row are pushed to.
      if (eventKey) {
        const fresh = new Set(result.rows.map((row) => row.user_id));
        for (let i = pushTo.length - 1; i >= 0; i -= 1) if (!fresh.has(pushTo[i])) pushTo.splice(i, 1);
      }
      if (ioRef) {
        for (const row of result.rows) if (liveTo.has(row.user_id)) ioRef.to(`user:${row.user_id}`).emit('notification:new', row);
      }
      for (const row of result.rows) {
        publish('notification', { userId: row.user_id, type: row.type, title: row.title || '', text: row.message || '' });
      }
    }
    if (push && pushTo.length) {
      sendPushToUsers(pushTo, title, body, { type, ...data }).catch(() => {});
    }
    return true;
  } catch (err) {
    console.error('[notify] failed:', err.message);
    return false;
  }
}

module.exports = { setIO, getIO, emitToUsers, notify, uniqueIds };
