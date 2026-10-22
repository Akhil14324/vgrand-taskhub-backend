const db = require('../db');
const { notify } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');

// Two small automatic messages so nobody writes status reports:
//  - 08:30, leaders: a brief of yesterday across the businesses they look after,
//  - 18:00, anyone who finished work today and has not posted their stand-up: "your update is drafted, tap to post".
const LEADER_HOUR = 8;
const LEADER_MIN = 30;
const UPDATE_HOUR = 18;
const INTERVAL_MS = 10 * 60 * 1000;

const clock = async () => (await db.query(
  'SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h, EXTRACT(MINUTE FROM NOW() AT TIME ZONE $1)::int AS m, EXTRACT(ISODOW FROM NOW() AT TIME ZONE $1)::int AS d',
  [APP_TIMEZONE]
)).rows[0];

const claim = async (userId, kind) => (await db.query(
  'INSERT INTO brief_log (user_id, day, kind) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING RETURNING user_id', [userId, todayInAppZone(), kind]
)).rows.length > 0;

async function leaderBriefs() {
  const { dailyReport } = require('../routes/reports');
  const leaders = (await db.query(`SELECT id FROM users WHERE status <> 'inactive' AND (org_level IS NOT NULL OR role IN ('admin', 'super_admin'))`)).rows;
  for (const { id } of leaders) {
    const actor = await loadActor(id);
    if (!actor || !actor.can('insights')) continue;
    if (!(await claim(id, 'leader'))) continue;
    const r = await dailyReport(actor);
    if (!r.businesses.length) continue;
    const t = r.totals;
    await notify([id], {
      type: 'daily_brief',
      title: `Yesterday: ${t.finished} finished, ${t.new_blockers} new roadblock${t.new_blockers === 1 ? '' : 's'}`,
      body: r.narrative || `${t.overdue} overdue across your businesses.`,
      data: { brief: 'daily' },
    });
  }
}

async function updateNudges() {
  const today = todayInAppZone();
  const people = (await db.query(
    `SELECT DISTINCT e.user_id AS id FROM todo_events e
     WHERE e.kind = 'completed' AND e.user_id IS NOT NULL AND (e.created_at AT TIME ZONE $2)::date = $1::date
       AND NOT EXISTS (SELECT 1 FROM standups s WHERE s.user_id = e.user_id AND s.day = $1::date)`,
    [today, APP_TIMEZONE]
  )).rows;
  for (const { id } of people) {
    if (!(await claim(id, 'update'))) continue;
    await notify([id], {
      type: 'standup_nudge',
      title: 'Your update is ready',
      body: 'We wrote today\'s update from what you finished. Check it and post it in one tap.',
      data: { standup: true },
    });
  }
}

async function run() {
  try {
    const c = await clock();
    if (c.d > 6) return;
    if (c.h > LEADER_HOUR || (c.h === LEADER_HOUR && c.m >= LEADER_MIN)) if (c.h < 12) await leaderBriefs();
    if (c.h >= UPDATE_HOUR && c.h < 21) await updateNudges();
  } catch (err) {
    console.error('[brief] failed:', err.message);
  }
}

function scheduleDailyBrief() {
  setTimeout(run, 5 * 60 * 1000);
  setInterval(run, INTERVAL_MS);
}

module.exports = { scheduleDailyBrief, run };
