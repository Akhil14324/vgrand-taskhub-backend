const db = require('../db');

// Chat messages are kept for 30 days and then deleted for good (replies, reactions, pins and read marks
// that pointed at them are cleared by the foreign keys). Attachment files are not touched here.
const KEEP_DAYS = 30;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

async function pruneOldMessages() {
  try {
    const res = await db.query(
      `DELETE FROM messages WHERE created_at < NOW() - make_interval(days => $1::int)`,
      [KEEP_DAYS]
    );
    if (res.rowCount) console.log(`[chat] removed ${res.rowCount} messages older than ${KEEP_DAYS} days`);
  } catch (err) {
    console.error('[chat] retention failed:', err.message);
  }
}

function scheduleChatRetention() {
  setTimeout(pruneOldMessages, 2 * 60 * 1000);
  setInterval(pruneOldMessages, INTERVAL_MS);
}

module.exports = { scheduleChatRetention, pruneOldMessages, KEEP_DAYS };
