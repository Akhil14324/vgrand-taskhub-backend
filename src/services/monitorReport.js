const db = require('../db');
const { APP_TIMEZONE } = require('../utils/recurrence');

// Team Monitor date reports: what happened in a chosen period, day by day, for everyone the viewer may watch (or
// one of them). Every date field is used for what it means: a task counts as CREATED on its creation day, ASSIGNED
// on its assignment day, DUE on its due date, COMPLETED on the day it was actually finished (the completion events),
// and PENDING / OVERDUE are measured at the END of the day or period (open then, and due before that day).
// All days are calendar days in the company timezone.

const DAY = 86400000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

const shift = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const mondayOf = (ymd) => shift(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const firstOfMonth = (ymd) => `${ymd.slice(0, 8)}01`;
const lastOfMonth = (ymd) => shift(`${shift(`${ymd.slice(0, 8)}01`, 40).slice(0, 8)}01`, -1);

function error(message) { const e = new Error(message); e.status = 400; e.statusCode = 400; return e; }

const PRESET_LABELS = {
  today: 'Today', yesterday: 'Yesterday', last7: 'Last 7 days', last30: 'Last 30 days',
  this_week: 'This week', last_week: 'Last week', this_month: 'This month', last_month: 'Last month', custom: 'Custom range',
};

/**
 * The inclusive day range for a preset (relative to `today`, a YYYY-MM-DD in the company timezone) or a custom range.
 * Weeks start on Monday. "This week" and "This month" run up to today, never into days that have not happened.
 */
function resolvePeriod({ preset, from, to } = {}, today) {
  if (preset && preset !== 'custom') {
    const p = String(preset);
    let r;
    if (p === 'today') r = [today, today];
    else if (p === 'yesterday') r = [shift(today, -1), shift(today, -1)];
    else if (p === 'last7') r = [shift(today, -6), today];
    else if (p === 'last30') r = [shift(today, -29), today];
    else if (p === 'this_week') r = [mondayOf(today), today];
    else if (p === 'last_week') { const m = shift(mondayOf(today), -7); r = [m, shift(m, 6)]; }
    else if (p === 'this_month') r = [firstOfMonth(today), today];
    else if (p === 'last_month') { const prev = shift(firstOfMonth(today), -1); r = [firstOfMonth(prev), prev]; }
    else throw error('Unknown date filter');
    return { preset: p, from: r[0], to: r[1], label: PRESET_LABELS[p] };
  }
  if (!YMD.test(from || '') || !YMD.test(to || '')) throw error('Choose a start date and an end date');
  if (from > to) throw error('The start date cannot be later than the end date');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw error(`Choose a range of at most ${MAX_RANGE_DAYS} days`);
  return { preset: 'custom', from, to, label: PRESET_LABELS.custom };
}

const pct = (done, pending) => (done + pending ? Math.round((done / (done + pending)) * 100) : null);

const EVENT_TEXT = {
  completed: (e) => `Completed "${e.todo_title}"`,
  due_changed: (e) => `Moved the date of "${e.todo_title}"${e.to_value ? ` to ${e.to_value}` : ''}`,
  deadline_changed: (e) => `Changed the deadline of "${e.todo_title}"${e.to_value ? ` to ${e.to_value}` : ''}`,
  priority_changed: (e) => `Changed the priority of "${e.todo_title}"${e.to_value ? ` to ${e.to_value}` : ''}`,
  reopened: (e) => `Reopened "${e.todo_title}"`,
  assigned: (e) => `Was given "${e.todo_title}"`,
  commented: (e) => `Comment on "${e.todo_title}"`,
  edited: (e) => `Edited "${e.todo_title}"`,
};
const eventText = (e) => (EVENT_TEXT[e.kind] || ((x) => `${String(x.kind).replace(/_/g, ' ')}: "${x.todo_title || 'a task'}"`))(e);

/** Pending = created by that day and not finished by the end of it. A finished task with no date counts as finished the day it was made. */
const TASKS = `
  SELECT id, assignee_id, due_date, is_done,
         (created_at AT TIME ZONE $2)::date AS cday,
         (assigned_at AT TIME ZONE $2)::date AS aday,
         (COALESCE(done_at, created_at) AT TIME ZONE $2)::date AS dday
  FROM todos
  WHERE parent_id IS NULL AND assignee_id = ANY($1::int[]) AND review_state <> 'rejected'`;
const OPEN_AT = '(t.cday <= d.day AND (NOT t.is_done OR t.dday > d.day))';

/**
 * The report. `ids` are the people in scope (already permission-checked); `page`/`limit` page the day sections
 * (newest first). The period totals and the per-person table always cover the whole period.
 */
async function buildReport(ids, period, { page = 1, limit = 31 } = {}) {
  const totalDays = daysBetween(period.from, period.to) + 1;
  const lim = Math.min(62, Math.max(1, parseInt(limit, 10) || 31));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const newestFirstStart = shift(period.to, -(pg - 1) * lim);
  const pageTo = newestFirstStart < period.from ? null : newestFirstStart;
  const pageFrom = pageTo ? (shift(pageTo, -(lim - 1)) < period.from ? period.from : shift(pageTo, -(lim - 1))) : null;

  if (!ids.length) {
    return { period, totals: emptyTotals(), people: [], days: [], pagination: { page: pg, limit: lim, total_days: totalDays, total_pages: Math.ceil(totalDays / lim) } };
  }

  const [totalsQ, peopleQ, completedPeriodQ, completedByPersonQ, dayQ, completedDayQ, activityQ] = await Promise.all([
    db.query(
      `WITH t AS (${TASKS}), d AS (SELECT $4::date AS day)
       SELECT COUNT(*) FILTER (WHERE t.cday BETWEEN $3::date AND $4::date)::int AS created,
              COUNT(*) FILTER (WHERE t.aday BETWEEN $3::date AND $4::date)::int AS assigned,
              COUNT(*) FILTER (WHERE ${OPEN_AT})::int AS pending_end,
              COUNT(*) FILTER (WHERE ${OPEN_AT} AND t.due_date < d.day)::int AS overdue_end
       FROM t, d`,
      [ids, APP_TIMEZONE, period.from, period.to]
    ),
    db.query(
      `WITH t AS (${TASKS}), d AS (SELECT $4::date AS day)
       SELECT t.assignee_id AS user_id,
              COUNT(*) FILTER (WHERE t.cday BETWEEN $3::date AND $4::date)::int AS created,
              COUNT(*) FILTER (WHERE t.aday BETWEEN $3::date AND $4::date)::int AS assigned,
              COUNT(*) FILTER (WHERE ${OPEN_AT})::int AS pending_end,
              COUNT(*) FILTER (WHERE ${OPEN_AT} AND t.due_date < d.day)::int AS overdue_end
       FROM t, d GROUP BY t.assignee_id`,
      [ids, APP_TIMEZONE, period.from, period.to]
    ),
    db.query(
      `SELECT COUNT(*)::int AS n FROM todo_events
       WHERE kind = 'completed' AND subject_id = ANY($1::int[]) AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE
         AND (created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`,
      [ids, APP_TIMEZONE, period.from, period.to]
    ),
    db.query(
      `SELECT subject_id AS user_id, COUNT(*)::int AS n FROM todo_events
       WHERE kind = 'completed' AND subject_id = ANY($1::int[]) AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE
         AND (created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
       GROUP BY subject_id`,
      [ids, APP_TIMEZONE, period.from, period.to]
    ),
    pageFrom
      ? db.query(
        `WITH t AS (${TASKS}), d AS (SELECT g::date AS day FROM generate_series($3::date, $4::date, interval '1 day') g)
         SELECT d.day::text AS day,
                COUNT(t.id) FILTER (WHERE t.cday = d.day)::int AS created,
                COUNT(t.id) FILTER (WHERE t.aday = d.day)::int AS assigned,
                COUNT(t.id) FILTER (WHERE t.due_date = d.day)::int AS due,
                COUNT(t.id) FILTER (WHERE ${OPEN_AT})::int AS pending,
                COUNT(t.id) FILTER (WHERE ${OPEN_AT} AND t.due_date < d.day)::int AS overdue
         FROM d LEFT JOIN t ON TRUE GROUP BY d.day ORDER BY d.day DESC`,
        [ids, APP_TIMEZONE, pageFrom, pageTo]
      )
      : { rows: [] },
    pageFrom
      ? db.query(
        `SELECT (created_at AT TIME ZONE $2)::date::text AS day, COUNT(*)::int AS n FROM todo_events
         WHERE kind = 'completed' AND subject_id = ANY($1::int[]) AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE
           AND (created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
         GROUP BY 1`,
        [ids, APP_TIMEZONE, pageFrom, pageTo]
      )
      : { rows: [] },
    pageFrom
      ? db.query(
        `SELECT e.id, e.todo_id, e.kind, e.user_id, u.name AS user_name, s.name AS person_name, e.from_value, e.to_value,
                e.created_at, (e.created_at AT TIME ZONE $2)::date::text AS day, COALESCE(t.title, e.meta->>'title') AS todo_title
         FROM todo_events e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN users s ON s.id = e.subject_id
         LEFT JOIN todos t ON t.id = e.todo_id
         WHERE e.subject_id = ANY($1::int[]) AND e.kind NOT IN ('created', 'shared')
           AND (e.created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
         ORDER BY e.created_at DESC LIMIT 600`,
        [ids, APP_TIMEZONE, pageFrom, pageTo]
      )
      : { rows: [] },
  ]);

  const tq = totalsQ.rows[0];
  const completed = completedPeriodQ.rows[0].n;
  const totals = { created: tq.created, assigned: tq.assigned, completed, pending_end: tq.pending_end, overdue_end: tq.overdue_end, completion_pct: pct(completed, tq.pending_end) };

  const doneBy = new Map(completedByPersonQ.rows.map((r) => [r.user_id, r.n]));
  const people = peopleQ.rows.map((r) => {
    const done = doneBy.get(r.user_id) || 0;
    return { user_id: r.user_id, created: r.created, assigned: r.assigned, completed: done, pending_end: r.pending_end, overdue_end: r.overdue_end, completion_pct: pct(done, r.pending_end) };
  });
  // People with only completions in the period (no task rows left) still show.
  for (const [uid, n] of doneBy) if (!people.some((p) => p.user_id === uid)) people.push({ user_id: uid, created: 0, assigned: 0, completed: n, pending_end: 0, overdue_end: 0, completion_pct: pct(n, 0) });

  const doneByDay = new Map(completedDayQ.rows.map((r) => [r.day, r.n]));
  const events = new Map();
  for (const e of activityQ.rows) {
    if (!events.has(e.day)) events.set(e.day, []);
    events.get(e.day).push({ id: e.id, todo_id: e.todo_id, kind: e.kind, person: e.person_name, by: e.user_name, at: e.created_at, text: eventText(e) });
  }
  const PER_DAY = 12;
  const days = dayQ.rows.map((r) => {
    const all = events.get(r.day) || [];
    const completedN = doneByDay.get(r.day) || 0;
    return {
      day: r.day, created: r.created, assigned: r.assigned, due: r.due, completed: completedN, pending: r.pending, overdue: r.overdue,
      activity: all.slice(0, PER_DAY), activity_more: Math.max(0, all.length - PER_DAY),
      empty: !r.created && !r.assigned && !r.due && !completedN && !all.length,
    };
  });

  return { period, totals, people, days, pagination: { page: pg, limit: lim, total_days: totalDays, total_pages: Math.ceil(totalDays / lim) } };
}

const emptyTotals = () => ({ created: 0, assigned: 0, completed: 0, pending_end: 0, overdue_end: 0, completion_pct: null });

module.exports = { resolvePeriod, buildReport, shift, daysBetween, PRESET_LABELS };
