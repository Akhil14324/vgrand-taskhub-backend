const db = require('../db');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { roastLine, daysBetween, MIN_DAYS_LATE, REPEAT_DAYS } = require('../utils/roast');

// Sent once a day, in the morning window (company timezone), only to people who switched "Overdue roast" on.
const FROM_HOUR = 10;
const TO_HOUR = 12;
const INTERVAL_MS = 30 * 60 * 1000;

const hourNow = async () => (await db.query('SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h', [APP_TIMEZONE])).rows[0].h;

async function sendRoasts() {
  try {
    const hour = await hourNow();
    if (hour < FROM_HOUR || hour >= TO_HOUR) return;
    const today = todayInAppZone();
    const late = await db.query(
      `SELECT t.id, t.title, t.assignee_id, t.due_date, t.last_roast_at
       FROM todos t JOIN users u ON u.id = t.assignee_id
       WHERE t.business_id IS NOT NULL AND t.review_state = 'accepted' AND t.is_done = FALSE
         AND t.status NOT IN ('done', 'on_hold', 'in_review')
         AND t.due_date <= $1::date - $2::int
         AND (t.last_roast_at IS NULL OR t.last_roast_at < NOW() - make_interval(days => $3::int))
         AND u.status <> 'inactive' AND u.preferences->'features'->>'roast' = 'true'`,
      [today, MIN_DAYS_LATE, REPEAT_DAYS]
    );
    for (const task of late.rows) {
      // Claim first so two overlapping runs never send the same one twice.
      const claimed = await db.query(
        `UPDATE todos SET last_roast_at = NOW()
         WHERE id = $1 AND (last_roast_at IS NULL OR last_roast_at < NOW() - make_interval(days => $2::int)) RETURNING id`,
        [task.id, REPEAT_DAYS]
      );
      if (!claimed.rows.length) continue;
      const days = daysBetween(task.due_date, today);
      const round = task.last_roast_at ? Math.floor(days / REPEAT_DAYS) : 0;
      await notify([task.assignee_id], {
        type: 'todo_roast',
        title: 'A little roast',
        body: roastLine(task.title, days, round),
        data: { todoId: task.id },
      });
    }
  } catch (err) {
    console.error('[roast] failed:', err.message);
  }
}

function scheduleRoast() {
  setTimeout(sendRoasts, 60 * 1000);
  setInterval(sendRoasts, INTERVAL_MS);
}

module.exports = { scheduleRoast, sendRoasts };
