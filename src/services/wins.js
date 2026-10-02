const db = require('../db');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { isLeader } = require('../utils/org');
const { shift } = require('../utils/streak');
const { streakFor, weekStart } = require('./engagement');
const { countCleanMonths, computeBadges } = require('../utils/badges');

/** My milestone badges and the numbers behind them. */
async function badgesFor(userId) {
  const today = todayInAppZone();
  const [totals, months, kudos, streak] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total FROM todo_events
       WHERE kind = 'completed' AND subject_id = $1 AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE`,
      [userId]
    ),
    db.query(
      `SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM') AS month,
              COUNT(*)::int AS done,
              COUNT(*) FILTER (WHERE meta->>'on_time' = 'false')::int AS late
       FROM todo_events
       WHERE kind = 'completed' AND subject_id = $1 AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE
       GROUP BY 1`,
      [userId, APP_TIMEZONE]
    ),
    db.query('SELECT COUNT(*)::int AS n FROM kudos WHERE to_user_id = $1', [userId]),
    streakFor(userId),
  ]);
  const stats = {
    total: totals.rows[0].total,
    longestStreak: streak.longest_streak,
    currentStreak: streak.streak,
    cleanMonths: countCleanMonths(months.rows, today.slice(0, 7)),
    kudos: kudos.rows[0].n,
  };
  return { stats, badges: computeBadges(stats) };
}

/**
 * "Done this week" for the company: what was finished on business work the person can see
 * (their own businesses, or all of them for leadership). Personal to-dos are never shown.
 */
async function weekWall(actor, offset = 0) {
  const start = await weekStart(offset);
  const leader = isLeader(actor);
  const businessIds = [...actor.memberships.keys()];
  const rows = (await db.query(
    `SELECT e.id, e.subject_id, e.created_at, e.todo_id,
            COALESCE(t.title, e.meta->>'title') AS title,
            COALESCE(t.business_id, NULLIF(e.meta->>'business_id', '')::int) AS business_id,
            e.meta->>'on_time' AS on_time,
            (e.created_at AT TIME ZONE $1)::date::text AS day,
            u.name, u.profile_picture, b.name AS business_name
     FROM todo_events e
     LEFT JOIN todos t ON t.id = e.todo_id
     JOIN users u ON u.id = e.subject_id
     LEFT JOIN businesses b ON b.id = COALESCE(t.business_id, NULLIF(e.meta->>'business_id', '')::int)
     WHERE e.kind = 'completed'
       AND e.created_at >= ($2::date)::timestamp AT TIME ZONE $1
       AND e.created_at < (($2::date + 7)::timestamp AT TIME ZONE $1)
       AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
       AND COALESCE(t.business_id, NULLIF(e.meta->>'business_id', '')::int) IS NOT NULL
       AND ($3::boolean OR COALESCE(t.business_id, NULLIF(e.meta->>'business_id', '')::int) = ANY($4::int[]))
     ORDER BY e.created_at DESC
     LIMIT 1000`,
    [APP_TIMEZONE, start, leader, businessIds]
  )).rows;

  const people = new Map();
  const businesses = new Map();
  const perDay = new Map();
  let onTime = 0;
  let timed = 0;
  for (const r of rows) {
    const p = people.get(r.subject_id) || { id: r.subject_id, name: r.name, profile_picture: r.profile_picture, count: 0 };
    p.count += 1;
    people.set(r.subject_id, p);
    const b = businesses.get(r.business_id) || { id: r.business_id, name: r.business_name, count: 0 };
    b.count += 1;
    businesses.set(r.business_id, b);
    perDay.set(r.day, (perDay.get(r.day) || 0) + 1);
    if (r.on_time === 'true' || r.on_time === 'false') {
      timed += 1;
      if (r.on_time === 'true') onTime += 1;
    }
  }
  const kudos = await db.query(
    `SELECT COUNT(*)::int AS n FROM kudos WHERE created_at >= ($2::date)::timestamp AT TIME ZONE $1 AND created_at < (($2::date + 7)::timestamp AT TIME ZONE $1)`,
    [APP_TIMEZONE, start]
  );
  return {
    week_start: start,
    week_end: shift(start, 6),
    totals: {
      done: rows.length,
      people: people.size,
      on_time_pct: timed ? Math.round((onTime / timed) * 100) : null,
      kudos: kudos.rows[0].n,
    },
    days: Array.from({ length: 7 }, (_, i) => {
      const day = shift(start, i);
      return { day, count: perDay.get(day) || 0 };
    }),
    top: [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5),
    businesses: [...businesses.values()].sort((a, b) => b.count - a.count),
    feed: rows.slice(0, 30).map((r) => ({
      id: r.id,
      user_id: r.subject_id,
      name: r.name,
      profile_picture: r.profile_picture,
      title: r.title,
      business_name: r.business_name,
      at: r.created_at,
      on_time: r.on_time === 'true' ? true : r.on_time === 'false' ? false : null,
      todo_id: r.todo_id,
    })),
  };
}

module.exports = { badgesFor, weekWall };
