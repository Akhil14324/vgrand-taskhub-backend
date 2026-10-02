const db = require('../db');
const { designationLevel } = require('../utils/org');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { addDays, daysBetween } = require('../utils/templates');
const { monitorablePeople, MONITOR_MAX_LEVEL } = require('./monitor');
const {
  WORK_DAY_MIN,
  WORK_DAYS_AHEAD,
  DEFAULT_TASK_MIN,
  healthScore,
  healthLevel,
  attentionReasons,
  loadMinutes,
  workloadState,
  estimateSummary,
  estimateVerdict,
} = require('../utils/insights');

const WEEKS = 8;

/** Businesses this actor may look at as a whole: all of them for leadership, the ones they head otherwise. */
async function businessesInScope(actor) {
  const all = (await db.query('SELECT id, name, type FROM businesses ORDER BY sort_order, name')).rows;
  if (actor.global !== null && actor.global !== undefined && actor.global <= 3) return all;
  const headOf = new Set(
    [...actor.memberships.entries()].filter(([, d]) => designationLevel(d) <= MONITOR_MAX_LEVEL).map(([id]) => Number(id))
  );
  return all.filter((b) => headOf.has(b.id));
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

/** Business health: open work, finished work and trend for each business in scope, plus company totals. */
async function businessHealth(actor, days) {
  const businesses = await businessesInScope(actor);
  if (!businesses.length) return { today: todayInAppZone(), days, businesses: [], totals: null };
  const ids = businesses.map((b) => b.id);
  const today = todayInAppZone();

  const [open, events, people] = await Promise.all([
    db.query(
      `SELECT t.business_id,
              COUNT(*) FILTER (WHERE NOT t.is_done)::int AS open,
              COUNT(*) FILTER (WHERE NOT t.is_done AND t.due_date < $2::date)::int AS overdue,
              COUNT(*) FILTER (WHERE NOT t.is_done AND t.status = 'blocked')::int AS blocked,
              COUNT(*) FILTER (WHERE NOT t.is_done AND t.status = 'in_review')::int AS in_review,
              COUNT(*) FILTER (WHERE NOT t.is_done AND t.assignee_id IS NULL)::int AS unassigned,
              COUNT(*) FILTER (WHERE NOT t.is_done AND t.due_date >= $2::date AND t.due_date <= $2::date + 7)::int AS due_soon
       FROM todos t
       WHERE t.business_id = ANY($1::int[]) AND t.parent_id IS NULL AND t.review_state = 'accepted'
       GROUP BY t.business_id`,
      [ids, today]
    ),
    db.query(
      `SELECT COALESCE((e.meta->>'business_id')::int, t.business_id) AS business_id,
              (e.created_at AT TIME ZONE $2)::date::text AS day,
              e.meta->>'on_time' AS on_time,
              (e.meta->>'cycle_s')::numeric AS cycle_s
       FROM todo_events e
       LEFT JOIN todos t ON t.id = e.todo_id
       WHERE e.kind = 'completed'
         AND e.created_at > NOW() - make_interval(days => $3)
         AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
         AND COALESCE((e.meta->>'business_id')::int, t.business_id) = ANY($1::int[])`,
      [ids, APP_TIMEZONE, Math.max(days * 2, WEEKS * 7) + 1]
    ),
    db.query(
      `SELECT business_id, COUNT(*)::int AS people FROM user_businesses WHERE business_id = ANY($1::int[]) GROUP BY business_id`,
      [ids]
    ),
  ]);

  const openBy = new Map(open.rows.map((r) => [r.business_id, r]));
  const peopleBy = new Map(people.rows.map((r) => [r.business_id, r.people]));
  const finished = new Map(ids.map((id) => [id, []]));
  for (const r of events.rows) finished.get(r.business_id)?.push(r);

  const rows = businesses.map((b) => {
    const o = openBy.get(b.id) || { open: 0, overdue: 0, blocked: 0, in_review: 0, unassigned: 0, due_soon: 0 };
    const done = finished.get(b.id) || [];
    const age = (r) => daysBetween(r.day, today);
    const now = done.filter((r) => age(r) < days);
    const before = done.filter((r) => age(r) >= days && age(r) < days * 2);
    const onTime = now.filter((r) => r.on_time === 'true').length;
    const late = now.filter((r) => r.on_time === 'false').length;
    const cycles = now.filter((r) => r.cycle_s !== null).map((r) => Number(r.cycle_s));
    const weekly = Array.from({ length: WEEKS }, () => 0);
    for (const r of done) {
      const w = Math.floor(age(r) / 7);
      if (w >= 0 && w < WEEKS) weekly[WEEKS - 1 - w] += 1;
    }
    const base = {
      ...b,
      ...o,
      people: peopleBy.get(b.id) || 0,
      completed: now.length,
      completed_before: before.length,
      completed_change: before.length ? Math.round(((now.length - before.length) / before.length) * 100) : null,
      on_time_rate: pct(onTime, onTime + late),
      avg_cycle_s: cycles.length ? Math.round(cycles.reduce((s, v) => s + v, 0) / cycles.length) : null,
      weekly,
    };
    const score = healthScore(base);
    return { ...base, score, level: healthLevel(score), reasons: attentionReasons(base) };
  });
  rows.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const judged = rows.filter((r) => r.on_time_rate !== null && r.completed > 0);
  const judgedWeight = judged.reduce((s, r) => s + r.completed, 0);
  const totals = {
    businesses: rows.length,
    people: sum('people'),
    open: sum('open'),
    overdue: sum('overdue'),
    blocked: sum('blocked'),
    unassigned: sum('unassigned'),
    due_soon: sum('due_soon'),
    completed: sum('completed'),
    completed_before: sum('completed_before'),
    on_time_rate: judgedWeight ? Math.round(judged.reduce((s, r) => s + r.on_time_rate * r.completed, 0) / judgedWeight) : null,
    weekly: Array.from({ length: WEEKS }, (_, i) => rows.reduce((s, r) => s + r.weekly[i], 0)),
    score: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null,
  };
  totals.level = totals.score === null ? null : healthLevel(totals.score);
  totals.completed_change = totals.completed_before
    ? Math.round(((totals.completed - totals.completed_before) / totals.completed_before) * 100)
    : null;
  return { today, days, businesses: rows, totals };
}

/**
 * Workload balance of the people this actor may watch: the minutes of work in front of each person
 * (overdue, due within a week, or already started) against five working days of capacity, plus a few
 * concrete suggestions to move a task from someone stretched to a colleague with room.
 */
async function workloadBalance(actorId) {
  const { actor, people } = await monitorablePeople(actorId);
  const today = todayInAppZone();
  const weekEnd = addDays(today, 7);
  if (!people.length) return { today, capacity_min: WORK_DAY_MIN * WORK_DAYS_AHEAD, people: [], suggestions: [], actor };

  const ids = people.map((p) => p.id);
  const rows = (await db.query(
    `SELECT t.id, t.title, t.status, t.priority, t.due_date, t.duration_minutes, t.business_id, t.assignee_id
     FROM todos t
     WHERE t.is_done = FALSE AND t.parent_id IS NULL AND t.assignee_id = ANY($1::int[])
       AND COALESCE(t.review_state, 'accepted') = 'accepted'
     ORDER BY t.due_date ASC NULLS LAST, t.priority ASC
     LIMIT 4000`,
    [ids]
  )).rows;

  const byPerson = new Map(ids.map((id) => [id, []]));
  for (const r of rows) byPerson.get(r.assignee_id)?.push(r);

  const capacity = WORK_DAY_MIN * WORK_DAYS_AHEAD;
  const out = people.map((p) => {
    const tasks = byPerson.get(p.id);
    const minutes = loadMinutes(tasks, today, weekEnd);
    return {
      ...p,
      open: tasks.length,
      overdue: tasks.filter((t) => t.due_date && t.due_date < today).length,
      due_week: tasks.filter((t) => t.due_date && t.due_date >= today && t.due_date <= weekEnd).length,
      load_min: minutes,
      ...workloadState(minutes, capacity),
    };
  });
  out.sort((a, b) => b.ratio - a.ratio || a.name.localeCompare(b.name));

  // Suggestions: take the least urgent movable business tasks off stretched people, give them to someone in the
  // same business who has the most room.
  const suggestions = [];
  const spare = new Map(out.map((p) => [p.id, capacity * 0.9 - p.load_min]));
  for (const from of out.filter((p) => p.ratio > 1)) {
    const movable = byPerson.get(from.id)
      .filter((t) => t.business_id && t.status === 'todo' && (!t.due_date || t.due_date <= weekEnd))
      .sort((a, b) => b.priority - a.priority || (b.due_date || '').localeCompare(a.due_date || ''));
    let excess = from.load_min - capacity;
    for (const task of movable) {
      if (excess <= 0 || suggestions.length >= 8) break;
      const minutes = task.duration_minutes || DEFAULT_TASK_MIN;
      const to = out
        .filter((p) => p.id !== from.id && p.business_ids.includes(task.business_id) && (spare.get(p.id) || 0) >= minutes)
        .sort((a, b) => (spare.get(b.id) || 0) - (spare.get(a.id) || 0))[0];
      if (!to) continue;
      spare.set(to.id, spare.get(to.id) - minutes);
      excess -= minutes;
      suggestions.push({
        todo_id: task.id,
        title: task.title,
        due_date: task.due_date,
        minutes,
        from: { id: from.id, name: from.name },
        to: { id: to.id, name: to.name, state: to.state },
      });
    }
  }
  return { today, capacity_min: capacity, people: out, suggestions };
}

/** Estimate vs actual from finished to-dos (the active time is what the estimate is judged against). */
async function estimateAccuracy(actorId, days, scope) {
  let ids = [actorId];
  let names = new Map();
  if (scope === 'team') {
    const { people } = await monitorablePeople(actorId);
    ids = people.map((p) => p.id);
    names = new Map(people.map((p) => [p.id, p.name]));
  }
  if (!ids.length) return { days, scope, overall: estimateSummary([]), covered: 0, finished: 0, people: [], buckets: [], misses: [] };

  const result = await db.query(
    `SELECT e.todo_id, e.subject_id AS user_id,
            COALESCE(e.meta->>'title', t.title) AS title,
            (e.meta->>'estimate_min')::numeric AS estimate_min,
            (e.meta->>'active_s')::numeric AS active_s,
            e.created_at
     FROM todo_events e
     LEFT JOIN todos t ON t.id = e.todo_id
     WHERE e.kind = 'completed' AND e.subject_id = ANY($1::int[])
       AND e.created_at > NOW() - make_interval(days => $2)
       AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
     ORDER BY e.created_at DESC
     LIMIT 5000`,
    [ids, days]
  );
  const rows = result.rows.map((r) => ({
    ...r,
    estimate_min: r.estimate_min === null ? null : Number(r.estimate_min),
    active_s: r.active_s === null ? null : Number(r.active_s),
  }));
  const judged = rows.filter((r) => r.estimate_min > 0 && r.active_s !== null);

  const perPerson = ids.map((id) => {
    const mine = judged.filter((r) => r.user_id === id);
    return { id, name: names.get(id) || null, ...estimateSummary(mine) };
  }).filter((p) => p.count > 0);
  perPerson.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));

  const sizes = [
    { key: 'short', label: 'Up to 30 minutes', test: (m) => m <= 30 },
    { key: 'medium', label: '30 minutes to 2 hours', test: (m) => m > 30 && m <= 120 },
    { key: 'long', label: 'Over 2 hours', test: (m) => m > 120 },
  ];
  const buckets = sizes.map((s) => ({ key: s.key, label: s.label, ...estimateSummary(judged.filter((r) => s.test(r.estimate_min))) }));

  const misses = judged
    .map((r) => ({
      todo_id: r.todo_id,
      title: r.title,
      user_id: r.user_id,
      person: names.get(r.user_id) || null,
      estimate_min: r.estimate_min,
      actual_min: Math.round(r.active_s / 60),
      ratio: Math.round((r.active_s / (r.estimate_min * 60)) * 100) / 100,
      finished_at: r.created_at,
    }))
    .filter((r) => Math.abs(r.actual_min - r.estimate_min) >= 10)
    .sort((a, b) => Math.abs(b.actual_min - b.estimate_min) - Math.abs(a.actual_min - a.estimate_min))
    .slice(0, 8);

  const overall = estimateSummary(judged);
  return {
    days,
    scope,
    overall: { ...overall, verdict: estimateVerdict(overall.ratio) },
    finished: rows.length,
    covered: judged.length,
    people: perPerson.map((p) => ({ ...p, verdict: estimateVerdict(p.ratio) })),
    buckets: buckets.map((b) => ({ ...b, verdict: estimateVerdict(b.ratio) })),
    misses,
  };
}

module.exports = { businessHealth, workloadBalance, estimateAccuracy };
