const db = require('../db');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { settingsOf } = require('../utils/notificationPrefs');
const openai = require('../utils/openai');

// Reliable, database-driven reminders (no GPT needed). Every notification carries an event key, so the
// database refuses a second copy for the same person and event: a missed tick is simply retried on the next
// one, and two server instances cannot double-send. Completed to-dos are skipped by the queries, deleted
// ones no longer exist. Reminders go to the person accountable (the assignee; people who only follow a to-do
// they handed over, or share it, get none unless it has no single owner), and each person's own settings (categories, reminder times, quiet hours) are applied
// by notify().
//   - "due in 1 day / 3 hours / 30 minutes" for to-dos with a time (the at-the-time reminder is todoReminders.js),
//   - "due tomorrow" at 09:00 for to-dos with a date only,
//   - "overdue" for personal to-dos (business ones are handled by overdueNotifications.js),
//   - afternoon and evening "still pending today" summaries (the morning one is nudges.js),
//   - at most one AI recommendation per person per day, only when their own data gives a reason.

const INTERVAL_MS = 5 * 60 * 1000;
// How long after its moment a missed reminder may still go out, so a restart never sends "in 1 day" an hour before.
const GRACE_MIN = { 1440: 360, 180: 60, 30: 15 };
const OVERDUE_GRACE_MIN = 60; // a timed to-do is "overdue" this long after its time
const OVERDUE_WINDOW_DAYS = 3; // never dig up older backlog
const DATE_ONLY_HOUR = 9;
const AFTERNOON = [14, 17];
const EVENING = [17, 21];
const AI_HOURS = [10, 16];
const AI_PER_RUN = 15;
const AI_MAX_TRIES = 3;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: APP_TIMEZONE }).format(new Date())) % 24;

/** Which lead (minutes) is due now for a deadline `dueMs`, given enabled leads: the nearest one whose moment has come and not run past its grace. */
function dueLeads(dueMs, leads, nowMs = Date.now()) {
  const minsLeft = (dueMs - nowMs) / 60000;
  if (minsLeft <= 0) return [];
  return leads.filter((lead) => minsLeft <= lead && lead - minsLeft <= (GRACE_MIN[lead] ?? 0));
}

function leadText(title, lead, at) {
  if (lead === 1440) return `Reminder: Your task '${title}' is due tomorrow${at ? ` at ${at}` : ''}.`;
  if (lead === 180) return `Reminder: Your task '${title}' is due in 3 hours.`;
  return `Reminder: Your task '${title}' is due in 30 minutes.`;
}

const prefsOf = async (ids) => {
  if (!ids.length) return new Map();
  const rows = (await db.query('SELECT id, preferences FROM users WHERE id = ANY($1::int[]) AND status <> \'inactive\'', [[...new Set(ids)]])).rows;
  return new Map(rows.map((r) => [r.id, settingsOf(r.preferences)]));
};

/** 1 day / 3 hours / 30 minutes before a to-do's time. */
async function sendLeadReminders() {
  const rows = (await db.query(
    `SELECT t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') AS d, to_char(t.due_time, 'HH12:MI AM') AS at,
            EXTRACT(EPOCH FROM ((t.due_date + t.due_time) AT TIME ZONE $1)) * 1000 AS due_ms,
            CASE WHEN t.assignee_id IS NOT NULL THEN ARRAY[t.assignee_id]
                 WHEN t.business_id IS NULL THEN ARRAY(SELECT m.user_id FROM todo_members m WHERE m.todo_id = t.id AND m.dumped_at IS NULL)
                 ELSE '{}'::int[] END AS users
     FROM todos t
     WHERE t.is_done = FALSE AND t.review_state <> 'rejected' AND t.due_date IS NOT NULL AND t.due_time IS NOT NULL
       AND ((t.due_date + t.due_time) AT TIME ZONE $1) BETWEEN NOW() AND NOW() + INTERVAL '25 hours'`,
    [APP_TIMEZONE]
  )).rows;
  const prefs = await prefsOf(rows.flatMap((r) => r.users));
  for (const t of rows) {
    for (const uid of t.users) {
      const s = prefs.get(uid);
      if (!s || s.reminders === false) continue;
      const leads = dueLeads(Number(t.due_ms), s.leads);
      // The nearest moment wins: a person who missed the 3-hour one is not sent it together with the 30-minute one.
      const lead = leads.length ? Math.min(...leads) : null;
      if (!lead) continue;
      await notify([uid], {
        type: 'todo_upcoming', title: 'Upcoming deadline', body: leadText(t.title, lead, t.at.replace(/^0/, '')), data: { todoId: t.id, lead },
      }, { eventKey: `remind:${t.id}:${t.d}T${t.due_ms}:${lead}` });
    }
  }
}

/** To-dos with a date but no time: one "due tomorrow" at 09:00. */
async function sendDateOnlyReminders() {
  if (hourNow() < DATE_ONLY_HOUR) return;
  const rows = (await db.query(
    `SELECT t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') AS d,
            CASE WHEN t.assignee_id IS NOT NULL THEN ARRAY[t.assignee_id]
                 WHEN t.business_id IS NULL THEN ARRAY(SELECT m.user_id FROM todo_members m WHERE m.todo_id = t.id AND m.dumped_at IS NULL)
                 ELSE '{}'::int[] END AS users
     FROM todos t
     WHERE t.is_done = FALSE AND t.review_state <> 'rejected' AND t.due_date = ($1::date + 1) AND t.due_time IS NULL`,
    [todayInAppZone()]
  )).rows;
  const prefs = await prefsOf(rows.flatMap((r) => r.users));
  for (const t of rows) {
    for (const uid of t.users) {
      const s = prefs.get(uid);
      if (!s || s.reminders === false || !s.leads.includes(1440)) continue;
      await notify([uid], { type: 'todo_upcoming', title: 'Upcoming deadline', body: leadText(t.title, 1440, null), data: { todoId: t.id, lead: 1440 } }, { eventKey: `remind:${t.id}:${t.d}:1440` });
    }
  }
}

/** Personal to-dos that slipped past their date. Business ones are announced by overdueNotifications.js. */
async function sendOverdue() {
  const rows = (await db.query(
    `SELECT t.id, t.title, to_char(t.due_date, 'YYYY-MM-DD') AS d,
            CASE WHEN t.assignee_id IS NOT NULL THEN ARRAY[t.assignee_id]
                 ELSE ARRAY(SELECT m.user_id FROM todo_members m WHERE m.todo_id = t.id AND m.dumped_at IS NULL) END AS users
     FROM todos t
     WHERE t.is_done = FALSE AND t.business_id IS NULL AND t.parent_id IS NULL AND t.due_date IS NOT NULL
       AND ((t.due_date + COALESCE(t.due_time, TIME '23:59')) AT TIME ZONE $1) + make_interval(mins => $2::int) < NOW()
       AND ((t.due_date + COALESCE(t.due_time, TIME '23:59')) AT TIME ZONE $1) > NOW() - make_interval(days => $3::int)`,
    [APP_TIMEZONE, OVERDUE_GRACE_MIN, OVERDUE_WINDOW_DAYS]
  )).rows;
  const prefs = await prefsOf(rows.flatMap((r) => r.users));
  for (const t of rows) {
    for (const uid of t.users) {
      const s = prefs.get(uid);
      if (!s || s.deadlines === false) continue;
      await notify([uid], { type: 'overdue', title: 'Task overdue', body: `Your task '${t.title}' is overdue. Please review it.`, data: { todoId: t.id } }, { eventKey: `overdue:${t.id}:${t.d}` });
    }
  }
}

/** People with open to-dos due today, with how many and the most important one. */
async function pendingToday(today) {
  return (await db.query(
    `WITH mine AS (
       SELECT m.user_id AS uid, t.id, t.title, t.priority FROM todos t
       JOIN todo_members m ON m.todo_id = t.id AND m.dumped_at IS NULL
       WHERE t.business_id IS NULL AND t.is_done = FALSE AND t.parent_id IS NULL AND t.due_date = $1::date
       UNION
       SELECT t.assignee_id, t.id, t.title, t.priority FROM todos t
       WHERE t.business_id IS NOT NULL AND t.assignee_id IS NOT NULL AND t.review_state = 'accepted'
         AND t.is_done = FALSE AND t.parent_id IS NULL AND t.due_date = $1::date
     )
     SELECT mine.uid, COUNT(*)::int AS n, (ARRAY_AGG(mine.title ORDER BY mine.priority, mine.id))[1] AS top
     FROM mine JOIN users u ON u.id = mine.uid AND u.status <> 'inactive' GROUP BY mine.uid`,
    [today]
  )).rows;
}

/** Afternoon (from 14:00) and evening (from 17:00) "still pending today" messages, built from the real counts. */
async function sendDailySummaries() {
  const h = hourNow();
  const kind = h >= EVENING[0] && h < EVENING[1] ? 'evening' : h >= AFTERNOON[0] && h < AFTERNOON[1] ? 'afternoon' : null;
  if (!kind) return;
  const today = todayInAppZone();
  const rows = await pendingToday(today);
  const prefs = await prefsOf(rows.map((r) => r.uid));
  for (const r of rows) {
    const s = prefs.get(r.uid);
    if (!s || s.daily === false) continue;
    const body = kind === 'afternoon'
      ? `You still have ${plural(r.n, 'pending task')} scheduled for today.`
      : `You have ${plural(r.n, 'incomplete task')} remaining. Review ${r.n === 1 ? 'it' : 'them'} before ending your day.`;
    await notify([r.uid], { type: 'daily_digest', title: kind === 'afternoon' ? 'Afternoon check-in' : 'Evening review', body, data: { type: 'daily_digest', top: r.top } }, { eventKey: `daily:${kind}:${today}` });
  }
}

// ---- AI recommendation: only from the person's own facts, at most once a day ----

const aiTries = new Map(); // `${uid}:${day}` -> attempts, so a failing key is not retried forever

/** The facts the AI may use for one person (counts and titles from their own open to-dos). */
async function factsFor(uid, today) {
  const own = `((t.business_id IS NULL AND EXISTS (SELECT 1 FROM todo_members m WHERE m.todo_id = t.id AND m.user_id = $1 AND m.dumped_at IS NULL))
                OR (t.business_id IS NOT NULL AND t.assignee_id = $1 AND t.review_state = 'accepted'))`;
  const q = async (extra, limit = 5) => (await db.query(
    `SELECT t.title FROM todos t WHERE t.is_done = FALSE AND t.parent_id IS NULL AND ${own} AND ${extra} ORDER BY t.priority, t.due_date LIMIT ${limit}`, [uid, today]
  )).rows.map((r) => r.title);
  const count = async (extra) => (await db.query(`SELECT COUNT(*)::int AS n FROM todos t WHERE t.is_done = FALSE AND t.parent_id IS NULL AND ${own} AND ${extra}`, [uid, today])).rows[0].n;
  const [highToday, overdue, stale, tomorrow, openTotal] = await Promise.all([
    count('t.priority <= 2 AND t.due_date = $2::date'),
    count('t.due_date < $2::date'),
    count("t.updated_at < NOW() - INTERVAL '3 days'"),
    count('t.due_date = ($2::date + 1)'),
    count('TRUE'),
  ]);
  return {
    highPriorityDueToday: highToday, overdue, notUpdatedForDays: stale, dueTomorrow: tomorrow, openTotal,
    sampleTitles: { overdue: await q('t.due_date < $2::date', 3), dueTomorrow: await q('t.due_date = ($2::date + 1)', 3), highToday: await q('t.priority <= 2 AND t.due_date = $2::date', 3) },
  };
}
const hasSignal = (f) => f.highPriorityDueToday >= 2 || f.overdue >= 1 || f.notUpdatedForDays >= 1 || f.dueTomorrow >= 1;

async function sendAiRecommendations() {
  if (!openai.configured()) return;
  const h = hourNow();
  if (h < AI_HOURS[0] || h >= AI_HOURS[1]) return;
  const today = todayInAppZone();
  const people = (await db.query(
    `SELECT u.id, u.preferences FROM users u
     WHERE u.status <> 'inactive'
       AND NOT EXISTS (SELECT 1 FROM brief_log b WHERE b.user_id = u.id AND b.day = $1::date AND b.kind = 'ai')
     ORDER BY u.id`, [today]
  )).rows;
  let used = 0;
  for (const p of people) {
    if (used >= AI_PER_RUN) break;
    const s = settingsOf(p.preferences);
    if (s.ai === false) continue;
    const key = `${p.id}:${today}`;
    if ((aiTries.get(key) || 0) >= AI_MAX_TRIES) continue;
    const facts = await factsFor(p.id, today);
    if (!hasSignal(facts)) continue;
    // The claim comes first so two servers do not both pay for the same answer; it is released if the AI fails.
    const claimed = (await db.query(`INSERT INTO brief_log (user_id, day, kind) VALUES ($1, $2::date, 'ai') ON CONFLICT DO NOTHING RETURNING user_id`, [p.id, today])).rows.length;
    if (!claimed) continue;
    used += 1;
    try {
      const out = await openai.chatJSON({
        system: 'You write one short, friendly productivity notification for a to-do app user. Use ONLY the numbers and titles in the facts. Never invent tasks, people, dates or numbers. If a count is 0, do not mention it. Reply as JSON: {"title": "max 40 characters", "message": "max 200 characters, one or two sentences, one concrete next step"}.',
        user: JSON.stringify(facts),
        temperature: 0.3,
        maxTokens: 200,
      });
      const title = String(out.title || '').trim().slice(0, 60);
      const message = String(out.message || '').trim().slice(0, 240);
      if (!title || !message) throw new Error('empty answer');
      await notify([p.id], { type: 'ai_recommendation', title, body: message, data: { ai: true } }, { eventKey: `ai:${today}` });
    } catch (err) {
      aiTries.set(key, (aiTries.get(key) || 0) + 1);
      await db.query(`DELETE FROM brief_log WHERE user_id = $1 AND day = $2::date AND kind = 'ai'`, [p.id, today]).catch(() => {});
      console.error('[smart-notifications] ai failed for', p.id, err.message);
    }
  }
}

async function run() {
  // Each step is independent: one failing never stops the others, and a failure is simply tried again next tick.
  for (const [name, step] of [['lead', sendLeadReminders], ['date-only', sendDateOnlyReminders], ['overdue', sendOverdue], ['daily', sendDailySummaries], ['ai', sendAiRecommendations]]) {
    try { await step(); } catch (err) { console.error(`[smart-notifications] ${name} failed:`, err.message); }
  }
}

function scheduleSmartNotifications() {
  setTimeout(run, 20 * 1000);
  setInterval(run, INTERVAL_MS);
}

module.exports = { scheduleSmartNotifications, run, dueLeads, leadText, sendLeadReminders, sendDateOnlyReminders, sendOverdue, sendDailySummaries, sendAiRecommendations };
