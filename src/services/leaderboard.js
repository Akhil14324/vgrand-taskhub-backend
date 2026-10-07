const db = require('../db');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { computeStreak } = require('../utils/streak');
const { isLeader } = require('../utils/org');

const PERIODS = { week: 7, month: 30, quarter: 90, all: 3650 };

/** Rank people by finished work. Ties go to the better on-time record, then the longer streak. */
function rankRows(rows) {
  const sorted = [...rows].sort((a, b) =>
    b.completed - a.completed
    || (b.on_time_rate ?? -1) - (a.on_time_rate ?? -1)
    || b.streak - a.streak
    || a.name.localeCompare(b.name));
  let rank = 0;
  let last = null;
  return sorted.map((row, i) => {
    const key = `${row.completed}|${row.on_time_rate}|${row.streak}`;
    if (key !== last) { rank = i + 1; last = key; }
    return { ...row, rank };
  });
}

/**
 * The people this viewer may see on the leaderboard: everyone in the businesses they belong to, or
 * everyone when they are leadership or hold the company-wide switch. `businessId` narrows it to one business.
 */
async function leaderboardFor(actor, { period = 'week', businessId = null } = {}) {
  const days = PERIODS[period] || PERIODS.week;
  const company = isLeader(actor) || actor.can('leaderboard_company');
  const myBusinessIds = [...actor.memberships.keys()];
  const scopeBusinessIds = businessId
    ? (company || myBusinessIds.includes(businessId) ? [businessId] : [])
    : (company ? null : myBusinessIds);

  const people = (await db.query(
    `SELECT DISTINCT u.id, u.name, u.username, u.profile_picture
     FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id
     WHERE u.status != 'inactive'
       AND ($1::int[] IS NULL OR ub.business_id = ANY($1::int[]))
       AND (u.org_level IS NOT NULL OR u.role <> 'super_admin' OR ub.user_id IS NOT NULL)`,
    [scopeBusinessIds]
  )).rows;
  if (!people.length) return { period, business_id: businessId, company, people: [], totals: { completed: 0, open: 0, overdue: 0 } };
  const ids = people.map((p) => p.id);
  const today = todayInAppZone();

  const [done, daily, rests, open] = await Promise.all([
    db.query(
      `SELECT e.subject_id AS user_id, COUNT(*)::int AS completed,
              COUNT(*) FILTER (WHERE e.meta->>'on_time' = 'true')::int AS on_time,
              COUNT(*) FILTER (WHERE e.meta->>'on_time' = 'false')::int AS late,
              AVG((e.meta->>'cycle_s')::numeric) AS avg_cycle_s
       FROM todo_events e
       LEFT JOIN todos t ON t.id = e.todo_id
       WHERE e.kind = 'completed' AND e.subject_id = ANY($1::int[])
         AND e.created_at > NOW() - make_interval(days => $2)
         AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
         AND ($3::int IS NULL OR COALESCE(t.business_id, NULLIF(e.meta->>'business_id', '')::int) = $3)
       GROUP BY e.subject_id`,
      [ids, days, businessId]
    ),
    db.query(
      `SELECT subject_id AS user_id, (created_at AT TIME ZONE $2)::date::text AS day, COUNT(*)::int AS count
       FROM todo_events
       WHERE kind = 'completed' AND subject_id = ANY($1::int[]) AND created_at > NOW() - INTERVAL '400 days'
       GROUP BY 1, 2`,
      [ids, APP_TIMEZONE]
    ),
    db.query(`SELECT user_id, day::text AS day FROM streak_rests WHERE user_id = ANY($1::int[]) AND day > CURRENT_DATE - 400`, [ids]),
    db.query(
      `SELECT t.assignee_id AS user_id, COUNT(*)::int AS open,
              COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND t.due_date < $2::date)::int AS overdue
       FROM todos t
       WHERE t.is_done = FALSE AND t.parent_id IS NULL AND t.review_state = 'accepted'
         AND t.assignee_id = ANY($1::int[])
         AND ($3::int IS NULL OR t.business_id = $3)
       GROUP BY t.assignee_id`,
      [ids, today, businessId]
    ),
  ]);

  const doneBy = new Map(done.rows.map((r) => [r.user_id, r]));
  const openBy = new Map(open.rows.map((r) => [r.user_id, r]));
  const dayMaps = new Map();
  for (const r of daily.rows) {
    if (!dayMaps.has(r.user_id)) dayMaps.set(r.user_id, new Map());
    dayMaps.get(r.user_id).set(r.day, r.count);
  }
  const restSets = new Map();
  for (const r of rests.rows) {
    if (!restSets.has(r.user_id)) restSets.set(r.user_id, new Set());
    restSets.get(r.user_id).add(r.day);
  }

  const rows = people.map((p) => {
    const d = doneBy.get(p.id);
    const o = openBy.get(p.id);
    const judged = d ? d.on_time + d.late : 0;
    const { current, longest } = computeStreak(dayMaps.get(p.id) || new Map(), restSets.get(p.id) || new Set(), today);
    return {
      id: p.id,
      name: p.name,
      username: p.username,
      profile_picture: p.profile_picture,
      completed: d ? d.completed : 0,
      on_time_rate: judged ? Math.round((d.on_time / judged) * 100) : null,
      avg_cycle_s: d && d.avg_cycle_s !== null ? Math.round(Number(d.avg_cycle_s)) : null,
      streak: current,
      longest_streak: longest,
      open: o ? o.open : 0,
      overdue: o ? o.overdue : 0,
      is_me: p.id === actor.id,
    };
  });

  const ranked = rankRows(rows);
  const totals = ranked.reduce((s, r) => ({
    completed: s.completed + r.completed, open: s.open + r.open, overdue: s.overdue + r.overdue,
  }), { completed: 0, open: 0, overdue: 0 });
  return { period, business_id: businessId, company, people: ranked, totals };
}

module.exports = { leaderboardFor, rankRows, PERIODS };
