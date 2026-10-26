const db = require('../db');
const { notify } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');

// Automatic messages so nobody writes status reports by hand, and so the daily report counts as attendance:
//  - 08:30, leaders: a brief of yesterday across the businesses they look after,
//  - 17:00 on working days, everyone who has not posted today's report: "due, drafted, tap to post",
//  - 18:30, the same people again: last call,
//  - 19:00, leadership: who has still not posted today.
const LEADER_HOUR = 8;
const LEADER_MIN = 30;
const REPORT_MIN = 17 * 60;
const LATE_MIN = 18 * 60 + 30;
const ATTENDANCE_MIN = 19 * 60;
const CUTOFF_MIN = 22 * 60;
const INTERVAL_MS = 10 * 60 * 1000;

const clock = async () => (await db.query(
  'SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h, EXTRACT(MINUTE FROM NOW() AT TIME ZONE $1)::int AS m, EXTRACT(ISODOW FROM NOW() AT TIME ZONE $1)::int AS d',
  [APP_TIMEZONE]
)).rows[0];

const claim = async (userId, kind) => (await db.query(
  'INSERT INTO brief_log (user_id, day, kind) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING RETURNING user_id', [userId, todayInAppZone(), kind]
)).rows.length > 0;

/** Active people placed in a business (or in the organisation), who have not posted today's report yet. */
const unpostedToday = async () => (await db.query(
  `SELECT u.id, u.name FROM users u
   WHERE u.status <> 'inactive'
     AND (u.org_level IS NOT NULL OR EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = u.id))
     AND NOT EXISTS (SELECT 1 FROM standups s WHERE s.user_id = u.id AND s.day = $1::date)
   ORDER BY u.name`,
  [todayInAppZone()]
)).rows;

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

/** Tell everyone who has not posted yet. Each person hears each reminder once a day. */
async function remindUnposted(kind, title, body) {
  for (const { id } of await unpostedToday()) {
    if (!(await claim(id, kind))) continue;
    await notify([id], { type: 'standup_nudge', title, body, data: { standup: true } });
  }
}

/** Leadership: who is still missing their daily report today. */
async function attendanceToLeaders() {
  const missing = await unpostedToday();
  if (!missing.length) return;
  const leaders = (await db.query(
    `SELECT id FROM users WHERE status <> 'inactive' AND org_level IS NOT NULL AND org_level <= 3`
  )).rows;
  const names = missing.slice(0, 8).map((p) => p.name).join(', ') + (missing.length > 8 ? ` and ${missing.length - 8} more` : '');
  for (const { id } of leaders) {
    if (!(await claim(id, 'attendance'))) continue;
    await notify([id], {
      type: 'standup_nudge',
      title: `${missing.length} daily report${missing.length === 1 ? '' : 's'} missing today`,
      body: names,
      data: { standup: true },
    });
  }
}

async function run() {
  try {
    const c = await clock();
    if (c.d > 6) return;
    const minutes = c.h * 60 + c.m;
    if (minutes >= LEADER_HOUR * 60 + LEADER_MIN && c.h < 12) await leaderBriefs();
    // The daily report is for working days (Monday to Friday, as in utils/standup.js).
    if (c.d >= 6 || minutes >= CUTOFF_MIN) return;
    if (minutes >= REPORT_MIN) await remindUnposted('report', 'Your daily report is due', 'We drafted it from what you finished. Check it and post it in one tap.');
    if (minutes >= LATE_MIN) await remindUnposted('report-late', 'Last call: daily report', 'Your daily report is still missing. Posting it counts as today\'s attendance.');
    if (minutes >= ATTENDANCE_MIN) await attendanceToLeaders();
  } catch (err) {
    console.error('[brief] failed:', err.message);
  }
}

function scheduleDailyBrief() {
  setTimeout(run, 5 * 60 * 1000);
  setInterval(run, INTERVAL_MS);
}

module.exports = { scheduleDailyBrief, run };
