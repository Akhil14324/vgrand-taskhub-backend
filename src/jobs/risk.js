const db = require('../db');
const { notify } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { APP_TIMEZONE } = require('../utils/recurrence');
const { atRisk } = require('../services/risk');

// Tells the person who owns the work (and whoever set it) about a to-do that looks likely to miss its date,
// once every three days per to-do, in the morning. See services/risk.js for how "likely" is worked out.
const FROM_HOUR = 9;
const TO_HOUR = 11;
const INTERVAL_MS = 60 * 60 * 1000;

async function warn() {
  try {
    const hour = (await db.query('SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h', [APP_TIMEZONE])).rows[0].h;
    if (hour < FROM_HOUR || hour >= TO_HOUR) return;
    const people = (await db.query(
      `SELECT DISTINCT assignee_id AS id FROM todos
       WHERE is_done = FALSE AND assignee_id IS NOT NULL AND COALESCE(deadline_date, due_date) BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`
    )).rows;
    for (const { id } of people) {
      const actor = await loadActor(id);
      if (!actor || actor.status === 'inactive') continue;
      const risky = (await atRisk(actor)).filter((r) => r.level === 'high' && r.assignee_id === id);
      for (const r of risky) {
        const claimed = await db.query(
          `UPDATE todos SET risk_warned_at = NOW() WHERE id = $1 AND (risk_warned_at IS NULL OR risk_warned_at < NOW() - INTERVAL '3 days') RETURNING id`,
          [r.id]
        );
        if (!claimed.rows.length) continue;
        await notify([...new Set([id, r.created_by].filter(Boolean))], {
          type: 'todo_at_risk',
          title: 'This may miss its date',
          body: `${r.title}: ${r.reasons[0]}.`,
          data: { todoId: r.id },
        });
      }
    }
  } catch (err) {
    console.error('[risk] failed:', err.message);
  }
}

function scheduleRisk() {
  setTimeout(warn, 4 * 60 * 1000);
  setInterval(warn, INTERVAL_MS);
}

module.exports = { scheduleRisk, warn };
