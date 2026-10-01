const db = require('../db');
const {
  DESIGNATIONS,
  LEADERSHIP,
  designationLevel,
  globalLevel,
  levelWithDesignation,
  displayTitle,
  loadActor,
  actorLevelIn,
} = require('../utils/org');
const { APP_TIMEZONE } = require('../utils/recurrence');
const { todoHealth } = require('../utils/timeline');

/**
 * Who may watch whose to-dos.
 *
 *  - Chairman, Chief of Staff, Director (leadership tiers): everyone strictly below them in the chain
 *    of command, across all businesses.
 *  - Business heads: people strictly below them, inside the businesses they head.
 *  - Never people above you or on your own level, and never other managers: only these ranks monitor.
 */
const MONITOR_MAX_LEVEL = DESIGNATIONS.head.level; // business head and above

async function loadDirectory() {
  const result = await db.query(
    `SELECT u.id, u.name, u.username, u.role, u.org_level, u.title, u.profile_picture, u.status, u.last_seen,
            COALESCE(json_agg(json_build_object(
              'business_id', ub.business_id, 'business_name', b.name, 'designation', ub.designation, 'title', ub.title
            ) ORDER BY b.sort_order, b.name) FILTER (WHERE ub.business_id IS NOT NULL), '[]') AS memberships
     FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id
     LEFT JOIN businesses b ON b.id = ub.business_id
     WHERE u.status != 'inactive'
     GROUP BY u.id`
  );
  return result.rows;
}

function bestLevel(u) {
  return Math.min(globalLevel(u) ?? 99, ...u.memberships.map((m) => designationLevel(m.designation)));
}

/** Can this actor use the monitor at all? */
function actorCanMonitor(actor) {
  if (!actor) return false;
  if (actor.global !== null && actor.global !== undefined && actor.global <= 3) return true;
  return [...actor.memberships.values()].some((d) => designationLevel(d) <= MONITOR_MAX_LEVEL);
}

/** Everyone this actor may watch, with display fields. */
async function monitorablePeople(actorId) {
  const actor = await loadActor(actorId);
  if (!actorCanMonitor(actor)) return { actor, people: [] };
  const directory = await loadDirectory();
  const isLeaderTier = actor.global !== null && actor.global !== undefined && actor.global <= 3;
  const headOf = new Set(
    [...actor.memberships.entries()].filter(([, d]) => designationLevel(d) <= MONITOR_MAX_LEVEL).map(([bid]) => Number(bid))
  );

  const people = [];
  for (const u of directory) {
    if (u.id === actor.id) continue;
    let allowed = false;
    if (isLeaderTier && bestLevel(u) > actor.global) allowed = true;
    if (!allowed) {
      allowed = u.memberships.some((m) =>
        headOf.has(Number(m.business_id))
        && levelWithDesignation(u, m.designation) > actorLevelIn(actor, m.business_id));
    }
    if (!allowed) continue;
    const level = bestLevel(u);
    people.push({
      id: u.id,
      name: u.name,
      username: u.username,
      profile_picture: u.profile_picture,
      last_seen: u.last_seen,
      level: level === 99 ? null : level,
      tier: u.org_level && LEADERSHIP[u.org_level] ? LEADERSHIP[u.org_level].label : null,
      display_title: displayTitle(u, u.memberships[0]?.designation, u.memberships[0]?.title),
      businesses: u.memberships.map((m) => m.business_name).filter(Boolean),
    });
  }
  people.sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name));
  return { actor, people };
}

const WINDOWS = [7, 30, 90];
function parseDays(value) {
  const n = parseInt(value, 10);
  return WINDOWS.includes(n) ? n : 30;
}

const OPEN_FIELDS = `
  t.id, t.title, t.status, t.status_since, t.status_seconds, t.assignee_id, t.assigned_at, t.created_at,
  t.started_at, t.is_done, t.done_at, t.duration_minutes, t.due_date,
  ((t.due_date + COALESCE(t.due_time, TIME '23:59')) AT TIME ZONE '${String(APP_TIMEZONE).replace(/'/g, "''")}') AS due_at,
  ((t.deadline_date + TIME '23:59') AT TIME ZONE '${String(APP_TIMEZONE).replace(/'/g, "''")}') AS deadline_at`;

/** Open work of these people (main to-dos they are accountable for), grouped with colour counts. */
async function openStats(userIds, now = Date.now()) {
  const result = await db.query(
    `SELECT ${OPEN_FIELDS} FROM todos t
     WHERE t.is_done = FALSE AND t.parent_id IS NULL AND t.assignee_id = ANY($1::int[])`,
    [userIds]
  );
  const byUser = new Map(userIds.map((id) => [id, { open: 0, overdue: 0, blocked: 0, in_progress: 0, health: { green: 0, orange: 0, red: 0, none: 0 } }]));
  const today = new Date(now).toISOString().slice(0, 10);
  for (const row of result.rows) {
    const s = byUser.get(row.assignee_id);
    if (!s) continue;
    s.open += 1;
    if (row.status === 'blocked') s.blocked += 1;
    if (row.status === 'in_progress') s.in_progress += 1;
    if (row.due_at && new Date(row.due_at).getTime() < now) s.overdue += 1;
    s.health[todoHealth(row, now).level] += 1;
  }
  void today;
  return byUser;
}

/** Completed-work numbers from the event log (so recurring and deleted to-dos still count). */
async function completionStats(userIds, days) {
  const result = await db.query(
    `SELECT subject_id AS user_id,
            COUNT(*)::int AS completed,
            AVG((meta->>'cycle_s')::numeric) AS avg_cycle_s,
            AVG((meta->>'lead_s')::numeric) AS avg_lead_s,
            AVG((meta->>'response_s')::numeric) AS avg_response_s,
            AVG((meta->>'blocked_s')::numeric) AS avg_blocked_s,
            COUNT(*) FILTER (WHERE meta->>'on_time' = 'true')::int AS on_time,
            COUNT(*) FILTER (WHERE meta->>'on_time' = 'false')::int AS late,
            AVG((meta->>'active_s')::numeric / NULLIF((meta->>'estimate_min')::numeric * 60, 0))
              FILTER (WHERE meta->>'estimate_min' IS NOT NULL AND meta->>'active_s' IS NOT NULL) AS estimate_ratio
     FROM todo_events
     WHERE kind = 'completed' AND subject_id = ANY($1::int[])
       AND created_at > NOW() - make_interval(days => $2)
       AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE
     GROUP BY subject_id`,
    [userIds, days]
  );
  const rescheduled = await db.query(
    `SELECT subject_id AS user_id, COUNT(*)::int AS reschedules
     FROM todo_events
     WHERE kind = 'due_changed' AND from_value IS NOT NULL AND subject_id = ANY($1::int[])
       AND created_at > NOW() - make_interval(days => $2)
     GROUP BY subject_id`,
    [userIds, days]
  );
  const map = new Map();
  const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
  for (const r of result.rows) {
    const judged = r.on_time + r.late;
    map.set(r.user_id, {
      completed: r.completed,
      avg_cycle_s: num(r.avg_cycle_s),
      avg_lead_s: num(r.avg_lead_s),
      avg_response_s: num(r.avg_response_s),
      avg_blocked_s: num(r.avg_blocked_s),
      on_time_rate: judged ? Math.round((r.on_time / judged) * 100) : null,
      estimate_ratio: r.estimate_ratio === null ? null : Math.round(Number(r.estimate_ratio) * 100) / 100,
    });
  }
  const resched = new Map(rescheduled.rows.map((r) => [r.user_id, r.reschedules]));
  return { map, resched };
}

const EMPTY_COMPLETION = {
  completed: 0, avg_cycle_s: null, avg_lead_s: null, avg_response_s: null, avg_blocked_s: null,
  on_time_rate: null, estimate_ratio: null,
};

/** Per-person numbers for the overview list. */
async function statsForPeople(userIds, days) {
  if (!userIds.length) return new Map();
  const [open, done] = await Promise.all([openStats(userIds), completionStats(userIds, days)]);
  const out = new Map();
  for (const id of userIds) {
    out.set(id, {
      ...open.get(id),
      ...(done.map.get(id) || EMPTY_COMPLETION),
      reschedules: done.resched.get(id) || 0,
    });
  }
  return out;
}

/** Whole-team numbers: sums for counts, completion-weighted averages for times. */
function teamTotals(statsByPerson) {
  const all = [...statsByPerson.values()];
  const sum = (key) => all.reduce((s, x) => s + (x[key] || 0), 0);
  const weighted = (key) => {
    const rows = all.filter((x) => x[key] !== null && x[key] !== undefined && x.completed > 0);
    const weight = rows.reduce((s, x) => s + x.completed, 0);
    return weight ? Math.round(rows.reduce((s, x) => s + x[key] * x.completed, 0) / weight) : null;
  };
  const judged = all.filter((x) => x.on_time_rate !== null && x.completed > 0);
  const judgedWeight = judged.reduce((s, x) => s + x.completed, 0);
  return {
    people: all.length,
    open: sum('open'),
    overdue: sum('overdue'),
    blocked: sum('blocked'),
    completed: sum('completed'),
    reschedules: sum('reschedules'),
    health: {
      green: all.reduce((s, x) => s + x.health.green, 0),
      orange: all.reduce((s, x) => s + x.health.orange, 0),
      red: all.reduce((s, x) => s + x.health.red, 0),
    },
    avg_cycle_s: weighted('avg_cycle_s'),
    avg_response_s: weighted('avg_response_s'),
    avg_blocked_s: weighted('avg_blocked_s'),
    on_time_rate: judgedWeight ? Math.round(judged.reduce((s, x) => s + x.on_time_rate * x.completed, 0) / judgedWeight) : null,
  };
}

/** Completions per day for the last 7 days, per person. */
async function weeklyCompletions(userId) {
  const result = await db.query(
    `SELECT (created_at AT TIME ZONE $2)::date::text AS day, COUNT(*)::int AS count
     FROM todo_events
     WHERE kind = 'completed' AND subject_id = $1 AND created_at > NOW() - INTERVAL '8 days'
       AND COALESCE((meta->>'is_subtask')::boolean, FALSE) = FALSE
     GROUP BY 1`,
    [userId, APP_TIMEZONE]
  );
  return result.rows;
}

module.exports = {
  MONITOR_MAX_LEVEL,
  actorCanMonitor,
  monitorablePeople,
  parseDays,
  statsForPeople,
  teamTotals,
  weeklyCompletions,
};
