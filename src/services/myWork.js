// My work: sorting a person's own open to-dos into the dashboard's sections and choosing what to do next.
// Pure functions over the rows listTodos returns (unit-tested); everything said about a task comes from its own fields.

const DAY = 86400000;
const earliest = (t) => [t.due_date, t.deadline_date].filter(Boolean).sort()[0] || null;
const dayNumber = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY);
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);
const PRIORITY_NAME = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

/** Waiting on something else: stuck, a roadblock is open, or a to-do it depends on is not finished. */
const isBlocked = (t) => t.status === 'blocked' || (t.open_blocker_count || 0) > 0 || (t.depends_on || []).some((d) => !d.is_done);

/**
 * The order of work: overdue first, then high-priority, then due today, due tomorrow, other dated work, and last
 * the work without a date. Blocked work sinks below what can be done now. Ties: priority, then date, then age.
 */
function rankOf(t, today) {
  const e = earliest(t);
  const days = e ? daysBetween(today, e) : null;
  let group;
  if (days !== null && days < 0) group = 0;
  else if (t.priority <= 2) group = 1;
  else if (days === 0) group = 2;
  else if (days === 1) group = 3;
  else if (days !== null) group = 4;
  else group = 5;
  return [isBlocked(t) ? 1 : 0, group, t.priority || 4, e || '9999-12-31', String(t.created_at || '')];
}
function compareRank(a, b) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
const byWork = (today) => (a, b) => compareRank(rankOf(a, today), rankOf(b, today));

/** One sentence on why this is the one, from its own dates and priority. */
function reasonFor(t, today) {
  const e = earliest(t);
  const days = e ? daysBetween(today, e) : null;
  const pri = t.priority <= 2 ? `${PRIORITY_NAME[t.priority]} priority` : null;
  if (days !== null && days < 0) return `Overdue by ${-days} day${days === -1 ? '' : 's'}${pri ? `, and ${pri.toLowerCase()}` : ''}. Finish it first.`;
  if (days === 0) return `${pri ? `${pri} and ` : ''}${pri ? 'due' : 'Due'} today${t.due_time ? ` at ${t.due_time}` : ''}.${pri ? ' Start here.' : ''}`;
  if (pri) return `${pri}${days !== null ? `, due ${days === 1 ? 'tomorrow' : e}` : ''}. Start here.`;
  if (days === 1) return 'Due tomorrow. A good head start.';
  if (days !== null) return `Next up: due ${e}.`;
  return 'No deadline set yet. Pick one so it does not slip.';
}

/** Short, factual tips; each one is only said when the numbers say it. */
function tipsFor({ overdue, dueToday, noDeadline, openTotal, doneToday, urgentLeft }) {
  const tips = [];
  const n = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  if (overdue) tips.push(`You have ${n(overdue, 'overdue task')}. Clear ${overdue === 1 ? 'it' : 'them'} first.`);
  if (dueToday) tips.push(`You have ${n(dueToday, 'task')} due today.`);
  if (noDeadline >= 3) tips.push(`${n(noDeadline, 'task')} ${noDeadline === 1 ? 'has' : 'have'} no deadline. Consider scheduling ${noDeadline === 1 ? 'it' : 'them'}.`);
  if (doneToday && !urgentLeft && !overdue) tips.push('You have finished your most important tasks for today.');
  if (!openTotal && !doneToday) tips.push('Nothing is open. Enjoy the clear list.');
  return tips;
}

/** Sort one person's open and finished-today to-dos into the sections of My work. */
function buildWork(open, doneToday, today) {
  const sorted = [...open].sort(byWork(today));
  const withDays = (t) => {
    const e = earliest(t);
    const d = e ? daysBetween(today, e) : null;
    return { ...t, overdue_days: d !== null && d < 0 ? -d : 0, blocked: isBlocked(t) };
  };
  const all = sorted.map(withDays);
  const dayOf = (t) => { const e = earliest(t); return e ? daysBetween(today, e) : null; };
  const overdue = all.filter((t) => dayOf(t) !== null && dayOf(t) < 0);
  const dueToday = all.filter((t) => dayOf(t) === 0);
  const upcoming = all.filter((t) => dayOf(t) !== null && dayOf(t) > 0 && dayOf(t) <= 7)
    .sort((a, b) => (earliest(a) < earliest(b) ? -1 : earliest(a) > earliest(b) ? 1 : compareRank(rankOf(a, today), rankOf(b, today))));
  const later = all.filter((t) => dayOf(t) !== null && dayOf(t) > 7);
  const noDeadline = all.filter((t) => dayOf(t) === null);
  const inProgress = all.filter((t) => t.status === 'in_progress');

  const pick = all.find((t) => !t.blocked && !t.parent_id) || all.find((t) => !t.blocked) || null;
  const next = pick ? { todo: pick, reason: reasonFor(pick, today) } : null;
  const urgentLeft = dueToday.some((t) => t.priority <= 2);
  const tips = tipsFor({ overdue: overdue.length, dueToday: dueToday.length, noDeadline: noDeadline.length, openTotal: open.length, doneToday: doneToday.length, urgentLeft });
  return { overdue, dueToday, upcoming, later, noDeadline, inProgress, next, tips };
}

module.exports = { buildWork, rankOf, byWork, reasonFor, isBlocked, earliest, daysBetween };
