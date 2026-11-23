const { listTodos } = require('./todoQueries');
const { todayInAppZone } = require('../utils/recurrence');

// The AI Assistant's numbers. Everything here is counted from the person's own view of the to-dos (listTodos
// applies the same visibility as the app), so a card or an insight never says something the data does not.
// The pure functions take plain rows so they can be tested without a database.

const DAY = 86400000;
const STALE_DAYS = 3; // "not updated" after this many days
const LONG_RUN_DAYS = 5; // "in progress" for longer than this is taking long

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const localDay = (ts) => (ts ? todayInAppZone(new Date(ts)) : null);
const daysSince = (ts, now) => (ts ? Math.floor((now - new Date(ts).getTime()) / DAY) : null);
/** The date that matters most: the deadline when there is one, else the due date. */
const keyDate = (t) => t.deadline_date || t.due_date || null;

/** The fields the dashboard, the reports and the AI need, nothing else. */
function slimTodo(t, now = Date.now()) {
  return {
    id: t.id,
    title: t.title,
    priority: t.priority,
    status: t.is_done ? 'done' : t.status,
    due_date: t.due_date || null,
    due_time: t.due_time || null,
    deadline_date: t.deadline_date || null,
    business: t.business_name || null,
    assignee: t.assignee_name || null,
    assignee_id: t.assignee_id || null,
    created_by: t.created_by_name || null,
    created_by_id: t.created_by,
    steps: t.subtask_count ? { done: t.subtask_done_count, total: t.subtask_count } : null,
    progress: t.is_done ? 100 : t.subtask_count ? Math.round((t.subtask_done_count / t.subtask_count) * 100) : 0,
    updated_days_ago: daysSince(t.updated_at, now),
    done_at: t.done_at || null,
  };
}

/**
 * Splits the rows into the person's own work, what was given to them, what they gave out, and the team.
 * Only top-level to-dos are counted (sub-tasks show up as progress of their parent), like the app's counts.
 */
function classify(rows, meId) {
  const top = rows.filter((t) => !t.parent_id && t.review_state !== 'rejected');
  const isMine = (t) => t.assignee_id === meId || (!t.assignee_id && (t.is_member || t.created_by === meId) && !t.watching);
  return {
    top,
    mine: top.filter(isMine),
    toMe: top.filter((t) => t.assignee_id === meId && t.created_by !== meId),
    byMe: top.filter((t) => t.created_by === meId && t.assignee_id && t.assignee_id !== meId),
    team: top.filter((t) => t.business_id && t.assignee_id),
  };
}

/** Per person: open, overdue and due-this-week work, and who is carrying much more than the rest. */
function workload(teamRows, today, meId) {
  const weekEnd = addDays(today, 7);
  const people = new Map();
  teamRows.filter((t) => !t.is_done).forEach((t) => {
    if (!people.has(t.assignee_id)) people.set(t.assignee_id, { id: t.assignee_id, name: t.assignee_name || 'Someone', open: 0, overdue: 0, due_week: 0, stuck: 0 });
    const p = people.get(t.assignee_id);
    p.open += 1;
    const d = keyDate(t);
    if (d && d < today) p.overdue += 1;
    if (d && d >= today && d <= weekEnd) p.due_week += 1;
    if (t.status === 'blocked' || t.open_blocker_count > 0) p.stuck += 1;
  });
  const list = [...people.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  const avg = list.length ? list.reduce((s, p) => s + p.open, 0) / list.length : 0;
  list.forEach((p) => {
    p.is_me = p.id === meId;
    p.overloaded = list.length > 1 && p.open >= 5 && p.open >= avg * 1.5;
    p.light = list.length > 2 && avg >= 3 && p.open <= avg * 0.4;
  });
  return { people: list, average: Math.round(avg * 10) / 10, uneven: list.some((p) => p.overloaded) && list.some((p) => p.light) };
}

/** The dashboard: counts, lists and rule-based insights. `now` is a timestamp (ms). */
function buildOverview(rows, me, now = Date.now()) {
  const today = todayInAppZone(new Date(now));
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);
  const { mine, toMe, byMe, team } = classify(rows, me.id);
  const open = mine.filter((t) => !t.is_done);
  const slim = (t) => slimTodo(t, now);
  const byDate = (a, b) => (keyDate(a) || '9999').localeCompare(keyDate(b) || '9999') || a.priority - b.priority;

  const overdue = open.filter((t) => keyDate(t) && keyDate(t) < today).sort(byDate);
  const dueToday = open.filter((t) => t.due_date === today || t.deadline_date === today).sort((a, b) => a.priority - b.priority);
  const completedToday = mine.filter((t) => t.is_done && localDay(t.done_at) === today);
  const upcoming = open.filter((t) => keyDate(t) && keyDate(t) >= today && keyDate(t) <= weekEnd).sort(byDate);
  const noDate = open.filter((t) => !t.due_date && !t.deadline_date);
  const stale = open.filter((t) => daysSince(t.updated_at, now) >= STALE_DAYS);
  const high = mine.filter((t) => t.priority <= 2);
  const runningLong = open.filter((t) => t.status === 'in_progress' && daysSince(t.status_since || t.started_at, now) >= LONG_RUN_DAYS);
  const bigNoSteps = open.filter((t) => !t.subtask_count && ((t.duration_minutes || 0) >= 240 || (t.story_points || 0) >= 5));
  const waitingOnOthers = [
    ...open.filter((t) => t.status === 'blocked' || t.open_blocker_count > 0 || (t.depends_on || []).some((d) => !d.is_done)),
    ...byMe.filter((t) => !t.is_done),
  ];
  const byMeStale = byMe.filter((t) => !t.is_done && daysSince(t.updated_at, now) >= STALE_DAYS);
  const teamOverdue = team.filter((t) => !t.is_done && t.assignee_id !== me.id && keyDate(t) && keyDate(t) < today);

  // Several of my to-dos landing on the same day in the next week: a likely clash.
  const perDay = new Map();
  upcoming.forEach((t) => { const d = keyDate(t); perDay.set(d, [...(perDay.get(d) || []), t]); });
  const conflicts = [...perDay.entries()]
    .filter(([, list]) => list.length >= 3 || list.filter((t) => t.priority === 1).length >= 2)
    .map(([day, list]) => ({ day, count: list.length, todos: list.map(slim) }));

  const insights = [];
  const add = (kind, tone, text, todos = []) => insights.push({ kind, tone, text, todo_ids: todos.map((t) => t.id) });
  const dueTomorrow = open.filter((t) => keyDate(t) === tomorrow).sort((a, b) => a.priority - b.priority);
  if (dueTomorrow.length) {
    const first = dueTomorrow[0];
    add('deadline_tomorrow', first.priority <= 2 ? 'urgent' : 'info',
      dueTomorrow.length === 1 ? `"${first.title}" is due tomorrow.` : `${dueTomorrow.length} to-dos are due tomorrow, starting with "${first.title}".`, dueTomorrow);
  }
  if (overdue.length) add('overdue', 'urgent', `${overdue.length} of your to-dos ${overdue.length === 1 ? 'is' : 'are'} past the date.`, overdue);
  conflicts.forEach((c) => add('conflict', 'warn', `${c.count} to-dos land on ${c.day}. Consider moving one.`, c.todos));
  if (byMeStale.length) add('assigned_stale', 'warn', `${byMeStale.length} to-do${byMeStale.length === 1 ? '' : 's'} you gave out ${byMeStale.length === 1 ? 'has' : 'have'} not been updated in ${STALE_DAYS}+ days.`, byMeStale);
  if (runningLong.length) add('running_long', 'warn', `${runningLong.length} to-do${runningLong.length === 1 ? ' has' : 's have'} been in progress for ${LONG_RUN_DAYS}+ days.`, runningLong);
  if (upcoming.length >= 10) add('workload_high', 'warn', `Your workload is high this week: ${upcoming.length} to-dos are due in the next 7 days.`, upcoming);
  if (noDate.length >= 3) add('no_deadline', 'info', `${noDate.length} open to-dos have no date. Giving them one helps you plan.`, noDate);
  bigNoSteps.slice(0, 2).forEach((t) => add('break_down', 'info', `"${t.title}" looks large. Consider breaking it into smaller steps.`, [t]));
  if (high.length && high.every((t) => t.is_done)) add('high_done', 'good', 'You have completed all your high-priority to-dos.');
  if (!open.length && mine.length) add('all_clear', 'good', 'Nothing open on your list right now.');

  return {
    today,
    counts: {
      due_today: dueToday.length,
      pending: open.length,
      completed_today: completedToday.length,
      overdue: overdue.length,
      no_date: noDate.length,
      stale: stale.length,
      assigned_to_me: toMe.filter((t) => !t.is_done).length,
      assigned_by_me: byMe.filter((t) => !t.is_done).length,
      waiting_on_others: waitingOnOthers.length,
      team_overdue: teamOverdue.length,
    },
    due_today: dueToday.slice(0, 8).map(slim),
    overdue: overdue.slice(0, 8).map(slim),
    upcoming: upcoming.slice(0, 8).map(slim),
    stale: stale.sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)).slice(0, 8).map(slim),
    assigned_to_me: toMe.filter((t) => !t.is_done).sort(byDate).slice(0, 8).map(slim),
    assigned_by_me: byMe.filter((t) => !t.is_done).sort(byDate).slice(0, 8).map(slim),
    waiting_on_others: waitingOnOthers.slice(0, 8).map(slim),
    team_overdue: teamOverdue.sort(byDate).slice(0, 8).map(slim),
    conflicts,
    workload: workload(team, today, me.id),
    insights,
  };
}

/** Daily or weekly report, from the data alone. `period`: 'day' | 'week'. */
function buildReport(rows, me, period = 'day', now = Date.now()) {
  const today = todayInAppZone(new Date(now));
  const tomorrow = addDays(today, 1);
  const { mine } = classify(rows, me.id);
  const open = mine.filter((t) => !t.is_done);
  const slim = (t) => slimTodo(t, now);
  const doneOn = (t) => (t.is_done ? localDay(t.done_at) : null);
  const delayed = open.filter((t) => keyDate(t) && keyDate(t) < today).sort((a, b) => keyDate(a).localeCompare(keyDate(b)));

  if (period === 'week') {
    const from = addDays(today, -6);
    const prevFrom = addDays(today, -13);
    const done = mine.filter((t) => doneOn(t) && doneOn(t) >= from);
    const prevDone = mine.filter((t) => doneOn(t) && doneOn(t) >= prevFrom && doneOn(t) < from);
    // This week's work: what was finished this week plus what is still open and was due by today.
    const dueOpen = open.filter((t) => keyDate(t) && keyDate(t) <= today);
    const base = done.length + dueOpen.length;
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => ({ day: d, completed: done.filter((t) => doneOn(t) === d).length }));
    return {
      period: 'week',
      from,
      to: today,
      completed: done.length,
      pending: open.length,
      progress_pct: base ? Math.round((done.length / base) * 100) : null,
      previous_week_completed: prevDone.length,
      trend: done.length > prevDone.length ? 'up' : done.length < prevDone.length ? 'down' : 'flat',
      per_day: days,
      accomplishments: done.sort((a, b) => a.priority - b.priority).slice(0, 6).map(slim),
      delayed: delayed.slice(0, 8).map(slim),
      next_week: open.filter((t) => keyDate(t) && keyDate(t) > today && keyDate(t) <= addDays(today, 7)).sort((a, b) => a.priority - b.priority).slice(0, 8).map(slim),
    };
  }
  const doneToday = mine.filter((t) => doneOn(t) === today);
  return {
    period: 'day',
    day: today,
    completed: doneToday.length,
    completed_list: doneToday.slice(0, 10).map(slim),
    pending: open.filter((t) => keyDate(t) && keyDate(t) <= today).length,
    pending_list: open.filter((t) => keyDate(t) === today).sort((a, b) => a.priority - b.priority).slice(0, 10).map(slim),
    tomorrow: open.filter((t) => keyDate(t) === tomorrow).sort((a, b) => a.priority - b.priority).slice(0, 8).map(slim),
    delayed: delayed.slice(0, 8).map(slim),
  };
}

/** Everything the person can see that is open or was finished in the last two weeks (incl. what they handed out). */
async function loadRows(actor) {
  return listTodos(actor.id, {
    actor,
    watching: 'any',
    where: "(t.is_done = FALSE OR t.done_at >= NOW() - INTERVAL '15 days') AND t.review_state <> 'rejected'",
    tail: 'ORDER BY t.id DESC LIMIT 2000',
  });
}

module.exports = { buildOverview, buildReport, classify, workload, slimTodo, loadRows, keyDate, addDays, STALE_DAYS };
