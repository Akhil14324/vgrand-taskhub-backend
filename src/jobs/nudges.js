const db = require('../db');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { dueSummary, waitingOnUser, weekStart, weekStats } = require('../services/engagement');

// Hour (company timezone) from which the morning digest goes out.
const DIGEST_HOUR = 8;
// Monday recap goes out from this hour.
const RECAP_HOUR = 9;
// A blocker that has waited this long for a person gets one reminder a day.
const BLOCKER_NUDGE_HOURS = 24;

const INTERVAL_MS = 5 * 60 * 1000;

const hourNow = async () => (await db.query('SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h', [APP_TIMEZONE])).rows[0].h;
const weekdayNow = async () => (await db.query('SELECT EXTRACT(ISODOW FROM NOW() AT TIME ZONE $1)::int AS d', [APP_TIMEZONE])).rows[0].d;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One calm message per person per morning: what is due, what is late and who is waiting on them.
 * Nothing is sent on a day with nothing to say, and people can turn it off in their settings.
 */
async function sendMorningDigests() {
  if ((await hourNow()) < DIGEST_HOUR) return;
  const today = todayInAppZone();
  const people = await db.query(
    `SELECT u.id FROM users u
     WHERE u.status <> 'inactive' AND COALESCE(u.preferences->>'morningDigest', 'true') <> 'false'
       AND NOT EXISTS (SELECT 1 FROM digest_log d WHERE d.user_id = u.id AND d.day = $1::date)`,
    [today]
  );
  for (const { id } of people.rows) {
    const claimed = await db.query(
      `INSERT INTO digest_log (user_id, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING RETURNING user_id`,
      [id, today]
    );
    if (!claimed.rows.length) continue;
    const [due, waiting, overdue] = await Promise.all([
      dueSummary(id, today),
      waitingOnUser(id),
      db.query(
        `SELECT COUNT(*)::int AS n FROM todos t
         WHERE t.is_done = FALSE AND t.parent_id IS NULL AND t.due_date < $2::date AND t.review_state <> 'rejected'
           AND ((t.business_id IS NULL AND EXISTS (SELECT 1 FROM todo_members m WHERE m.todo_id = t.id AND m.user_id = $1))
                OR (t.business_id IS NOT NULL AND t.assignee_id = $1 AND t.review_state = 'accepted'))`,
        [id, today]
      ),
    ]);
    const late = overdue.rows[0].n;
    const todayCount = Math.max(0, due - late);
    if (!todayCount && !late && !waiting.length) continue;
    const parts = [];
    if (todayCount) parts.push(`${plural(todayCount, 'task')} due today`);
    if (late) parts.push(`${late} overdue`);
    if (waiting.length) parts.push(`${waiting.length} ${waiting.length === 1 ? 'person is' : 'people are'} waiting on you`);
    await notify([id], {
      type: 'daily_digest',
      title: 'Your day',
      body: parts.join(', '),
      data: { type: 'daily_digest' },
    });
  }
}

/** Remind a person once a day that someone's work is held up until they act. */
async function sendBlockerNudges() {
  const today = todayInAppZone();
  const stuck = await db.query(
    `UPDATE todo_blockers b SET nudged_on = $1::date
     FROM todos t
     WHERE t.id = b.todo_id AND t.is_done = FALSE
       AND b.resolved_at IS NULL AND b.blocked_by_user_id IS NOT NULL
       AND b.raised_at < NOW() - make_interval(hours => $2)
       AND b.nudged_on IS DISTINCT FROM $1::date
     RETURNING b.id, b.blocked_by_user_id AS user_id, b.raised_at, t.id AS todo_id, t.title,
               (SELECT name FROM users WHERE id = COALESCE(t.assignee_id, b.raised_by)) AS who`,
    [today, BLOCKER_NUDGE_HOURS]
  );
  for (const row of stuck.rows) {
    const days = Math.max(1, Math.floor((Date.now() - new Date(row.raised_at).getTime()) / 86400000));
    await notify([row.user_id], {
      type: 'blocker_nudge',
      title: `${row.who || 'Someone'} is waiting on you`,
      body: `${row.title} has been held up for ${plural(days, 'day')}`,
      data: { type: 'blocker_nudge', todoId: row.todo_id },
    });
  }
}

/** Monday morning: last week in one line, with a link to the full recap. */
async function sendWeeklyRecaps() {
  if ((await weekdayNow()) !== 1 || (await hourNow()) < RECAP_HOUR) return;
  const thisWeek = await weekStart(0);
  const lastWeek = await weekStart(1);
  const people = await db.query(
    `SELECT u.id FROM users u
     WHERE u.status <> 'inactive' AND COALESCE(u.preferences->>'morningDigest', 'true') <> 'false'
       AND NOT EXISTS (SELECT 1 FROM recap_log r WHERE r.user_id = u.id AND r.week_start = $1::date)`,
    [thisWeek]
  );
  for (const { id } of people.rows) {
    const claimed = await db.query(
      `INSERT INTO recap_log (user_id, week_start) VALUES ($1, $2::date) ON CONFLICT DO NOTHING RETURNING user_id`,
      [id, thisWeek]
    );
    if (!claimed.rows.length) continue;
    const stats = await weekStats(id, lastWeek);
    if (!stats.completed && !stats.updates) continue;
    const bits = [`${plural(stats.completed, 'task')} finished`];
    if (stats.on_time_rate !== null) bits.push(`${stats.on_time_rate}% on time`);
    if (stats.kudos_received) bits.push(`${stats.kudos_received} kudos received`);
    await notify([id], {
      type: 'weekly_recap',
      title: 'Your week in review',
      body: bits.join(', '),
      data: { type: 'weekly_recap' },
    });
  }
}

async function runNudges() {
  try {
    await sendMorningDigests();
    await sendBlockerNudges();
    await sendWeeklyRecaps();
  } catch (err) {
    console.error('[nudges] failed:', err.message);
  }
}

function scheduleNudges() {
  setTimeout(runNudges, 30 * 1000);
  setInterval(runNudges, INTERVAL_MS);
}

module.exports = { scheduleNudges, runNudges, sendMorningDigests, sendBlockerNudges, sendWeeklyRecaps };
