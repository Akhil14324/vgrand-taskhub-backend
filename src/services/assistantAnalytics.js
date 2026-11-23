const { buildReport, classify, workload, slimTodo, keyDate, addDays } = require('./assistantInsights');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');

// More numbers for the AI Assistant: business and team progress, the monthly report, priority suggestions,
// workload balancing and the suggested questions. Like assistantInsights.js, every function takes plain rows
// (what listTodos returned for the person, so only what they may see) and counts them: no AI, nothing invented.

const localDay = (ts) => (ts ? todayInAppZone(new Date(ts)) : null);
const doneDay = (t) => (t.is_done ? localDay(t.done_at) : null);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
const byKey = (a, b) => (keyDate(a) || '9999').localeCompare(keyDate(b) || '9999') || a.priority - b.priority;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const live = (t) => !t.parent_id && t.review_state !== 'rejected';

/**
 * Per business the person can see: open, overdue, stuck and unassigned work, what was finished in the last
 * `windowDays` days and the share that is done. `most_pending` names the business with the most open work.
 */
function businessSummary(rows, today, windowDays = 7, now = Date.now()) {
  const from = addDays(today, -(windowDays - 1));
  const map = new Map();
  rows.filter((t) => live(t) && t.business_id).forEach((t) => {
    if (!map.has(t.business_id)) map.set(t.business_id, { id: t.business_id, name: t.business_name || 'Business', open: 0, overdue: 0, blocked: 0, unassigned: 0, completed: 0, attention: [] });
    const b = map.get(t.business_id);
    if (t.is_done) {
      const d = doneDay(t);
      if (d && d >= from) b.completed += 1;
      return;
    }
    b.open += 1;
    const k = keyDate(t);
    const late = !!k && k < today;
    const stuck = t.status === 'blocked' || t.open_blocker_count > 0;
    if (late) b.overdue += 1;
    if (stuck) b.blocked += 1;
    if (!t.assignee_id) b.unassigned += 1;
    if (late || stuck) b.attention.push(t);
  });
  const businesses = [...map.values()]
    .map(({ attention, ...b }) => ({ ...b, progress_pct: pct(b.completed, b.completed + b.open), attention: attention.sort(byKey).slice(0, 3).map((t) => slimTodo(t, now)) }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  return { window_days: windowDays, businesses, most_pending: businesses.length && businesses[0].open ? businesses[0].name : null };
}

/** Per person (of the work the viewer can see): finished in the window, open, overdue and the share finished on time. */
function teamPerformance(rows, today, windowDays = 7) {
  const from = addDays(today, -(windowDays - 1));
  const people = new Map();
  const get = (t) => {
    if (!people.has(t.assignee_id)) people.set(t.assignee_id, { id: t.assignee_id, name: t.assignee_name || 'Someone', completed: 0, open: 0, overdue: 0, dated: 0, onTime: 0 });
    return people.get(t.assignee_id);
  };
  rows.filter((t) => live(t) && t.assignee_id).forEach((t) => {
    const k = keyDate(t);
    if (t.is_done) {
      const d = doneDay(t);
      if (!d || d < from) return;
      const p = get(t);
      p.completed += 1;
      if (k) { p.dated += 1; if (d <= k) p.onTime += 1; }
      return;
    }
    const p = get(t);
    p.open += 1;
    if (k && k < today) p.overdue += 1;
  });
  return [...people.values()]
    .map(({ dated, onTime, ...p }) => ({ ...p, on_time_rate: dated >= 3 ? pct(onTime, dated) : null })) // a rate from fewer than 3 to-dos says little
    .sort((a, b) => b.completed - a.completed || b.open - a.open || a.name.localeCompare(b.name));
}

/**
 * Priority suggestions from the dates and the dependencies, not from a model: overdue work, work due today or
 * tomorrow, work other to-dos wait for, and urgent work that is not due for weeks. Only the person's own to-dos
 * that they may edit. Each says why.
 */
function prioritySuggestions(rows, me, now = Date.now()) {
  const today = todayInAppZone(new Date(now));
  const { mine, top } = classify(rows, me.id);
  const waiting = new Map(); // id of an open to-do -> how many open to-dos wait for it
  top.filter((t) => !t.is_done).forEach((t) => (t.depends_on || []).forEach((d) => { if (!d.is_done) waiting.set(d.id, (waiting.get(d.id) || 0) + 1); }));
  const out = [];
  mine.filter((t) => !t.is_done).forEach((t) => {
    if (t.permissions && t.permissions.can_edit === false) return;
    const k = keyDate(t);
    let target = null;
    let why = '';
    let urgency = 0;
    if (k && k < today) {
      const days = dayDiff(today, k);
      if (t.priority > 2) { target = 2; why = `Overdue by ${plural(days, 'day', 'days')}`; urgency = 100 + days; }
      else if (t.priority === 2 && days >= 7) { target = 1; why = `Overdue by ${days} days`; urgency = 90 + days; }
    } else if (k === today && t.priority >= 3) {
      target = 2; why = 'Due today'; urgency = 80;
    } else if (k === addDays(today, 1) && t.priority === 4) {
      target = 3; why = 'Due tomorrow'; urgency = 60;
    }
    const waits = waiting.get(t.id) || 0;
    if (!target && waits && t.priority > 2) { target = 2; why = `${plural(waits, 'other to-do waits', 'other to-dos wait')} for this one`; urgency = 50 + waits; }
    if (!target && t.priority === 1 && k && dayDiff(k, today) > 21 && t.status !== 'in_progress') {
      target = 3; why = `Marked urgent, but not due for ${dayDiff(k, today)} days`; urgency = 10;
    }
    if (target && target !== t.priority) out.push({ id: t.id, title: t.title, from: t.priority, priority: target, why, urgency });
  });
  return out.sort((a, b) => b.urgency - a.urgency).slice(0, 8).map(({ urgency, ...x }) => x);
}

/** When the team is uneven: a few to-dos of overloaded people the viewer may reassign, and to whom. */
function balanceMoves(teamRows, wl) {
  if (!wl.uneven) return [];
  const light = wl.people.filter((p) => p.light).sort((a, b) => a.open - b.open);
  if (!light.length) return [];
  const moves = [];
  wl.people.filter((p) => p.overloaded).forEach((from, i) => {
    const to = light[i % light.length];
    teamRows
      .filter((t) => !t.is_done && t.assignee_id === from.id && t.status !== 'in_progress' && t.priority > 1 && t.permissions && t.permissions.can_assign)
      .sort((a, b) => b.priority - a.priority || byKey(b, a))
      .slice(0, 2)
      .forEach((t) => moves.push({ todo_id: t.id, title: t.title, from: from.name, to: to.name, to_id: to.id, why: `${from.name} has ${from.open} open, ${to.name} has ${to.open}` }));
  });
  return moves.slice(0, 4);
}

/** Questions worth asking right now, from the person's real numbers. Always at least a few. */
function suggestQuestions(ov, { hour = 12, businesses = 0 } = {}) {
  const c = ov.counts;
  const q = [];
  const add = (s) => { if (!q.includes(s)) q.push(s); };
  if (c.pending > 0 || c.due_today > 0) add('Read me my plan for today');
  if (hour >= 16) add('Summarize my day and plan tomorrow'); // the end of the day is the time for it
  if (c.overdue > 0) add(c.overdue === 1 ? 'Show my overdue task' : `Show my ${c.overdue} overdue tasks`);
  if (ov.upcoming.length) add('Show my upcoming deadlines');
  if (c.overdue > 0 || ov.stale.length) add('What is slipping this week?');
  if (c.overdue > 0 || ov.upcoming.length) add('Which tasks are likely to miss their dates?');
  if (businesses > 0) add('How are the businesses doing?');
  if (c.assigned_to_me > 0) add('What tasks are assigned to me?');
  if (c.assigned_by_me > 0) add('What tasks have I assigned to others?');
  if (c.team_overdue > 0) add('Which assigned tasks are overdue?');
  if (ov.insights.some((i) => i.kind === 'assigned_stale')) add('Which assigned tasks have not been updated?');
  if (ov.workload.people.length > 1) add("Summarize my team's progress");
  if (ov.workload.uneven) add('Balance the workload across the team');
  if (c.pending > 1) add('What should I prioritize?');
  if (c.no_date >= 3) add('Which tasks have no deadline?');
  if (ov.conflicts.length) add('Help me fix my busiest day');
  if (ov.insights.some((i) => i.kind === 'break_down')) add('Break down my biggest task into steps');
  if (c.completed_today > 0) add('Show my completed tasks');
  if (c.pending > 0) add('Show my pending tasks');
  add('Summarize my weekly progress');
  add('Suggest improvements for our workflow');
  return q.slice(0, 8);
}

/** The hour of the day in the app's time zone (0 to 23). */
const hourNow = (now = Date.now()) => Number(new Date(now).toLocaleString('en-GB', { timeZone: APP_TIMEZONE, hour: '2-digit', hour12: false })) % 24;

/** Of the person's to-dos finished since `from`: the share that was done by its date (null when too few have a date). */
function onTimeRate(mine, from) {
  const dated = mine.filter((t) => doneDay(t) && doneDay(t) >= from && keyDate(t));
  return dated.length >= 3 ? pct(dated.filter((t) => doneDay(t) <= keyDate(t)).length, dated.length) : null;
}

/** The monthly report: the last 30 days against the 30 before, week by week. */
function monthReport(rows, me, now = Date.now()) {
  const today = todayInAppZone(new Date(now));
  const from = addDays(today, -29);
  const prevFrom = addDays(today, -59);
  const { mine } = classify(rows, me.id);
  const slim = (t) => slimTodo(t, now);
  const open = mine.filter((t) => !t.is_done);
  const done = mine.filter((t) => doneDay(t) && doneDay(t) >= from);
  const prevDone = mine.filter((t) => doneDay(t) && doneDay(t) >= prevFrom && doneDay(t) < from);
  const delayed = open.filter((t) => keyDate(t) && keyDate(t) < today).sort(byKey);
  const dueOpen = open.filter((t) => keyDate(t) && keyDate(t) <= today);
  const per_week = [0, 1, 2, 3].map((i) => {
    const to = addDays(today, -7 * (3 - i));
    const start = i === 0 ? from : addDays(to, -6);
    return { label: `Week ${i + 1}`, from: start, to, completed: done.filter((t) => doneDay(t) >= start && doneDay(t) <= to).length };
  });
  return {
    period: 'month',
    from,
    to: today,
    completed: done.length,
    previous_period_completed: prevDone.length,
    change_pct: prevDone.length ? Math.round(((done.length - prevDone.length) / prevDone.length) * 100) : null,
    trend: done.length > prevDone.length ? 'up' : done.length < prevDone.length ? 'down' : 'flat',
    pending: open.length,
    progress_pct: pct(done.length, done.length + dueOpen.length),
    on_time_rate: onTimeRate(mine, from),
    per_week,
    accomplishments: done.sort((a, b) => a.priority - b.priority).slice(0, 6).map(slim),
    // "Projects" here are the bigger to-dos that have steps.
    completed_projects: done.filter((t) => t.subtask_count > 0).slice(0, 8).map(slim),
    delayed: delayed.slice(0, 8).map(slim),
    delayed_projects: delayed.filter((t) => t.subtask_count > 0).slice(0, 8).map(slim),
    next_week: open.filter((t) => keyDate(t) && keyDate(t) > today && keyDate(t) <= addDays(today, 7)).sort((a, b) => a.priority - b.priority).slice(0, 8).map(slim),
  };
}

/** What to improve, from the numbers of the report. At most six short sentences; empty when all is well. */
function focusAreas({ delayed = 0, onTime = null, completed = 0, previous = 0, businesses = [], team = [], uneven = null }) {
  const out = [];
  if (delayed >= 3) out.push(`${delayed} of your to-dos are overdue. Re-plan or clear them first.`);
  if (onTime !== null && onTime < 70) out.push(`Only ${onTime}% of the to-dos you finished were done by their date.`);
  if (previous >= 3 && completed <= previous * 0.7) out.push(`Fewer to-dos were finished than before (${completed} against ${previous}).`);
  businesses.forEach((b) => {
    if (b.open >= 3 && b.overdue / b.open >= 0.3) out.push(`${b.name}: ${b.overdue} of ${b.open} open tasks are overdue.`);
    if (b.unassigned >= 3) out.push(`${b.name}: ${b.unassigned} open tasks have nobody assigned.`);
  });
  team.forEach((p) => { if (p.open >= 5 && p.overdue >= 2) out.push(`${p.name} has ${p.overdue} overdue of ${p.open} open to-dos.`); });
  if (uneven && uneven.overloaded.length) out.push(`${uneven.overloaded.map((p) => p.name).join(' and ')} carr${uneven.overloaded.length === 1 ? 'ies' : 'y'} much more than the rest of the team.`);
  return out.slice(0, 6);
}

/** Short observations on how the period went, from the numbers only. */
function productivityInsights(report, onTime) {
  const out = [];
  const prev = report.period === 'month' ? report.previous_period_completed : report.previous_week_completed;
  const label = report.period === 'month' ? 'month' : 'week';
  if (report.completed || prev) out.push(`You finished ${plural(report.completed, 'to-do', 'to-dos')} this ${label}${prev ? `, ${report.completed >= prev ? 'compared with' : 'down from'} ${prev} before` : ''}.`);
  if (onTime !== null) out.push(`${onTime}% of the to-dos you finished were done by their date.`);
  const best = (report.per_day || []).reduce((m, d) => (d.completed > (m ? m.completed : 0) ? d : m), null);
  if (best) out.push(`Your most productive day was ${new Date(`${best.day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} (${best.completed} finished).`);
  if (report.delayed && report.delayed.length) out.push(`${plural(report.delayed.length, 'to-do is', 'to-dos are')} past the date.`);
  return out;
}

/**
 * The report for 'day', 'week' or 'month'. Week and month also carry business progress, team progress,
 * productivity observations and areas to improve.
 */
function fullReport(rows, me, period = 'day', now = Date.now()) {
  if (period === 'day') return buildReport(rows, me, 'day', now);
  const today = todayInAppZone(new Date(now));
  const month = period === 'month';
  const base = month ? monthReport(rows, me, now) : buildReport(rows, me, 'week', now);
  const windowDays = month ? 30 : 7;
  const { mine, team } = classify(rows, me.id);
  const businesses = businessSummary(rows, today, windowDays, now).businesses;
  const people = teamPerformance(rows, today, windowDays);
  const wl = workload(team, today, me.id);
  const onTime = base.on_time_rate !== undefined ? base.on_time_rate : onTimeRate(mine, addDays(today, -6));
  return {
    ...base,
    on_time_rate: onTime,
    businesses,
    team: people,
    productivity_insights: productivityInsights(base, onTime),
    focus_areas: focusAreas({
      delayed: base.delayed.length,
      onTime,
      completed: base.completed,
      previous: month ? base.previous_period_completed : base.previous_week_completed,
      businesses,
      team: people,
      uneven: wl.uneven ? { overloaded: wl.people.filter((p) => p.overloaded) } : null,
    }),
  };
}

/**
 * The plan route lays work into time blocks and uses a default length when a to-do has none. The assistant must
 * not present that guess as an estimate, so times and lengths are kept only for to-dos that have a length of
 * their own (`rows`: the person's to-dos, with duration_minutes).
 */
function withoutGuessedTimes(plan, rows) {
  if (!plan || !Array.isArray(plan.plan)) return plan;
  const known = new Map(rows.map((t) => [t.id, t.duration_minutes || null]));
  const strip = (item) => (known.get(item.id)
    ? item
    : { id: item.id, title: item.title, why: item.why, priority: item.priority, due_date: item.due_date, business_name: item.business_name, estimate: 'not set' });
  return { today: plan.today, plan: plan.plan.map(strip), overflow: (plan.overflow || []).map(strip), note: 'Times and lengths are given only where the to-do has an estimate of its own.' };
}

// Why each kind of insight matters, and what to do about it. The action is a question for the chat: anything it
// leads to is a proposal the person confirms.
const INSIGHT_HELP = {
  deadline_tomorrow: { why: 'Work due tomorrow is easiest to finish if you start today.', label: 'Plan it', ask: 'What should I finish first for tomorrow?' },
  overdue: { why: 'Late work keeps growing and can hold up other people.', label: 'Re-plan overdue', ask: 'Help me re-plan my overdue tasks' },
  conflict: { why: 'Too much on one day usually means something slips.', label: 'Spread it out', ask: 'Help me fix my busiest day' },
  assigned_stale: { why: 'Work nobody updates can be stuck without anyone noticing.', label: 'Follow up', ask: 'Which assigned tasks have not been updated?' },
  running_long: { why: 'Work that stays in progress for long may be stuck or too big.', label: 'Review', ask: 'Which of my tasks have been in progress for a long time?' },
  workload_high: { why: 'A heavy week raises the risk that dates are missed.', label: 'Lighten the week', ask: 'What can I postpone this week?' },
  no_deadline: { why: 'To-dos without a date are easy to forget and hard to plan.', label: 'Review them', ask: 'Show my tasks without a deadline' },
  break_down: { why: 'Large tasks are easier to start and to track in smaller steps.', label: 'Break it down', ask: 'Break down my biggest task into steps' },
  high_done: { why: 'A good moment to look at what comes next.', label: 'Plan ahead', ask: 'What should I work on next?' },
  all_clear: { why: 'Nothing needs you right now.', label: null, ask: null },
};

/** The overview's insights as recommendations: what needs attention, why it matters and a suggested action. */
function recommendations(insights) {
  return (insights || []).map((i) => {
    const help = INSIGHT_HELP[i.kind] || {};
    let ask = help.ask || null;
    if (i.kind === 'break_down') {
      const m = /^"(.*)" looks large/.exec(i.text || '');
      if (m) ask = `Break down "${m[1]}" into steps`;
    }
    return { kind: i.kind, tone: i.tone, what: i.text, why: help.why || null, todo_ids: i.todo_ids || [], action: ask && help.label ? { label: help.label, ask } : null };
  });
}

/** What the overview adds beyond its own numbers: businesses, priorities, balancing, recommendations, questions. */
function overviewExtras(rows, me, ov, now = Date.now()) {
  const { businesses } = businessSummary(rows, ov.today, 7, now);
  const { team } = classify(rows, me.id);
  return {
    businesses,
    priority_suggestions: prioritySuggestions(rows, me, now),
    balance_moves: balanceMoves(team, ov.workload),
    recommendations: recommendations(ov.insights),
    questions: suggestQuestions(ov, { hour: hourNow(now), businesses: businesses.length }),
  };
}

module.exports = {
  businessSummary, teamPerformance, prioritySuggestions, balanceMoves, suggestQuestions, hourNow, monthReport, fullReport, focusAreas, productivityInsights,
  recommendations, overviewExtras, withoutGuessedTimes,
};
