const db = require('../db');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { computeStreak, shift } = require('../utils/streak');

/** Items still owed today by this person: overdue or due today, theirs to do. */
async function dueSummary(userId, today) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS remaining FROM todos t
     WHERE t.is_done = FALSE AND t.parent_id IS NULL AND t.review_state <> 'rejected'
       AND t.due_date IS NOT NULL AND t.due_date <= $2::date
       AND ((t.business_id IS NULL AND EXISTS (SELECT 1 FROM todo_members m WHERE m.todo_id = t.id AND m.user_id = $1))
            OR (t.business_id IS NOT NULL AND t.assignee_id = $1 AND t.review_state = 'accepted'))`,
    [userId, today]
  );
  return result.rows[0].remaining;
}

/** Completions per day (company timezone) for the last year, credited to the accountable person. */
async function completionsByDay(userId, days = 365) {
  const result = await db.query(
    `SELECT (created_at AT TIME ZONE $2)::date::text AS day, COUNT(*)::int AS count
     FROM todo_events
     WHERE kind = 'completed' AND subject_id = $1 AND created_at > NOW() - make_interval(days => $3)
     GROUP BY 1`,
    [userId, APP_TIMEZONE, days]
  );
  return new Map(result.rows.map((r) => [r.day, r.count]));
}

async function restDays(userId) {
  const result = await db.query(
    `SELECT day::text AS day FROM streak_rests WHERE user_id = $1 AND day > CURRENT_DATE - 400`,
    [userId]
  );
  return new Set(result.rows.map((r) => r.day));
}

/** Streak numbers plus whether today is "all clear"; records a clear day the first time it is seen. */
async function streakFor(userId) {
  const today = todayInAppZone();
  const [byDay, rests, remaining] = await Promise.all([completionsByDay(userId), restDays(userId), dueSummary(userId, today)]);
  const { current, longest } = computeStreak(byDay, rests, today);
  const doneToday = byDay.get(today) || 0;
  const allClear = remaining === 0 && doneToday > 0;
  if (allClear) {
    await db.query(
      `INSERT INTO daily_clear (user_id, day, completed) VALUES ($1, $2::date, $3)
       ON CONFLICT (user_id, day) DO UPDATE SET completed = EXCLUDED.completed`,
      [userId, today, doneToday]
    );
  }
  return {
    today,
    streak: current,
    longest_streak: longest,
    done_today: doneToday,
    remaining_today: remaining,
    all_clear: allClear,
    resting_today: rests.has(today),
    rests: [...rests].filter((d) => d >= shift(today, -30)).sort(),
    week: Array.from({ length: 7 }, (_, i) => {
      const day = shift(today, i - 6);
      return { day, count: byDay.get(day) || 0 };
    }),
  };
}

/** Things other people are stuck on until this person acts: open blockers that name them. */
async function waitingOnUser(userId) {
  const result = await db.query(
    `SELECT b.id AS blocker_id, b.kind, b.note, b.raised_at, t.id AS todo_id, t.title,
            u.id AS by_id, u.name AS by_name, u.profile_picture AS by_picture
     FROM todo_blockers b
     JOIN todos t ON t.id = b.todo_id AND t.is_done = FALSE
     LEFT JOIN users u ON u.id = COALESCE(t.assignee_id, b.raised_by)
     WHERE b.resolved_at IS NULL AND b.blocked_by_user_id = $1
       AND (t.business_id IS NOT NULL OR EXISTS (SELECT 1 FROM todo_members m WHERE m.todo_id = t.id AND m.user_id = $1))
     ORDER BY b.raised_at`,
    [userId]
  );
  return result.rows;
}

/** Monday (YYYY-MM-DD, company timezone) of the week `offset` weeks ago. */
async function weekStart(offset = 0) {
  const result = await db.query(
    `SELECT (date_trunc('week', NOW() AT TIME ZONE $1)::date - ($2::int * 7))::text AS start`,
    [APP_TIMEZONE, offset]
  );
  return result.rows[0].start;
}

const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

/** One person's numbers for the week starting `start` (a Monday). */
async function weekStats(userId, start) {
  const end = shift(start, 7);
  const [done, activity, kudos, perDay, best] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS completed,
              COUNT(*) FILTER (WHERE COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE)::int AS main_completed,
              COUNT(*) FILTER (WHERE meta->>'on_time' = 'true')::int AS on_time,
              COUNT(*) FILTER (WHERE meta->>'on_time' = 'false')::int AS late,
              AVG((meta->>'cycle_s')::numeric) FILTER (WHERE COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE) AS avg_cycle_s
       FROM todo_events
       WHERE kind = 'completed' AND subject_id = $1
         AND (created_at AT TIME ZONE $2)::date >= $3::date AND (created_at AT TIME ZONE $2)::date < $4::date`,
      [userId, APP_TIMEZONE, start, end]
    ),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE kind = 'update')::int AS updates,
              COUNT(*) FILTER (WHERE kind = 'blocker_cleared')::int AS blockers_cleared
       FROM todo_events
       WHERE user_id = $1
         AND (created_at AT TIME ZONE $2)::date >= $3::date AND (created_at AT TIME ZONE $2)::date < $4::date`,
      [userId, APP_TIMEZONE, start, end]
    ),
    db.query(
      `SELECT COUNT(*)::int AS received FROM kudos
       WHERE to_user_id = $1 AND (created_at AT TIME ZONE $2)::date >= $3::date AND (created_at AT TIME ZONE $2)::date < $4::date`,
      [userId, APP_TIMEZONE, start, end]
    ),
    db.query(
      `SELECT (created_at AT TIME ZONE $2)::date::text AS day, COUNT(*)::int AS count
       FROM todo_events
       WHERE kind = 'completed' AND subject_id = $1
         AND (created_at AT TIME ZONE $2)::date >= $3::date AND (created_at AT TIME ZONE $2)::date < $4::date
       GROUP BY 1`,
      [userId, APP_TIMEZONE, start, end]
    ),
    db.query(
      `SELECT e.todo_id, COALESCE(t.title, e.meta->>'title') AS title, (e.meta->>'cycle_s')::numeric AS cycle_s
       FROM todo_events e LEFT JOIN todos t ON t.id = e.todo_id
       WHERE e.kind = 'completed' AND e.subject_id = $1 AND e.meta->>'cycle_s' IS NOT NULL
         AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
         AND (e.created_at AT TIME ZONE $2)::date >= $3::date AND (e.created_at AT TIME ZONE $2)::date < $4::date
       ORDER BY (e.meta->>'cycle_s')::numeric ASC LIMIT 1`,
      [userId, APP_TIMEZONE, start, end]
    ),
  ]);
  const d = done.rows[0];
  const byDay = new Map(perDay.rows.map((r) => [r.day, r.count]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = shift(start, i);
    return { day, count: byDay.get(day) || 0 };
  });
  const judged = d.on_time + d.late;
  const busiest = [...days].sort((a, b) => b.count - a.count)[0];
  return {
    start,
    end: shift(start, 6),
    completed: d.completed,
    main_completed: d.main_completed,
    on_time_rate: judged ? Math.round((d.on_time / judged) * 100) : null,
    avg_cycle_s: num(d.avg_cycle_s),
    updates: activity.rows[0].updates,
    blockers_cleared: activity.rows[0].blockers_cleared,
    kudos_received: kudos.rows[0].received,
    days,
    busiest_day: busiest && busiest.count > 0 ? busiest.day : null,
    quickest: best.rows[0] ? { todo_id: best.rows[0].todo_id, title: best.rows[0].title, cycle_s: num(best.rows[0].cycle_s) } : null,
  };
}

module.exports = { dueSummary, completionsByDay, restDays, streakFor, waitingOnUser, weekStart, weekStats };
