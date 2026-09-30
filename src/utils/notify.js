const db = require('../db');
const { sendPushToUsers } = require('./push');

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
    }
    if (push) {
      sendPushToUsers(ids, title, body, { type, ...data }).catch(() => {});
    }
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

module.exports = { setIO, getIO, emitToUsers, notify, uniqueIds };
