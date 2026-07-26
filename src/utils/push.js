const db = require('../db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Send push notifications to a list of Expo push tokens.
 * @param {string[]} tokens - Expo push token strings
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {object} data - Optional data payload for deep linking
 */
async function sendPushToTokens(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

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
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();

    if (result.errors && result.errors.length > 0) {
      const invalidTokens = [];
      for (const ticket of result.data || []) {
        if (ticket.status === 'error' && ticket.details && ticket.details.error === 'DeviceNotRegistered') {
          invalidTokens.push(ticket.ticket ? messages[ticket.ticket].to : null);
        }
      }
      if (invalidTokens.length > 0) {
        await cleanupInvalidTokens(invalidTokens.filter(Boolean));
      }
      console.error('[push] Some notifications failed:', JSON.stringify(result.errors));
    }
  } catch (err) {
    console.error('[push] Error sending push notifications:', err.message);
  }
}

/**
 * Send a push notification to all registered devices for a single user.
 */
async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const result = await db.query(
      'SELECT token FROM push_tokens WHERE user_id = $1',
      [userId]
    );
    if (result.rows.length === 0) return;
    const tokens = result.rows.map((r) => r.token);
    await sendPushToTokens(tokens, title, body, data);
  } catch (err) {
    console.error('[push] Error sending to user:', err.message);
  }
}

/**
 * Send a push notification to multiple users.
 */
async function sendPushToUsers(userIds, title, body, data = {}) {
  if (!userIds || userIds.length === 0) return;
  try {
    const result = await db.query(
      'SELECT token FROM push_tokens WHERE user_id = ANY($1)',
      [userIds]
    );
    if (result.rows.length === 0) return;
    const tokens = result.rows.map((r) => r.token);
    await sendPushToTokens(tokens, title, body, data);
  } catch (err) {
    console.error('[push] Error sending to users:', err.message);
  }
}

/**
 * Remove invalid (unregistered) tokens from the database.
 */
async function cleanupInvalidTokens(tokens) {
  if (!tokens || tokens.length === 0) return;
  try {
    await db.query('DELETE FROM push_tokens WHERE token = ANY($1)', [tokens]);
  } catch (err) {
    console.error('[push] Error cleaning up invalid tokens:', err.message);
  }
}

module.exports = { sendPushToTokens, sendPushToUser, sendPushToUsers, cleanupInvalidTokens };
