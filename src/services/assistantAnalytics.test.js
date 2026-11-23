const test = require('node:test');
const assert = require('node:assert');
const { addDays, buildOverview, classify, workload } = require('./assistantInsights');
const {
  businessSummary, teamPerformance, prioritySuggestions, balanceMoves, suggestQuestions, hourNow, monthReport, fullReport,
} = require('./assistantAnalytics');

const NOW = Date.parse('2026-11-23T08:00:00Z'); // afternoon in Asia/Kolkata
const TODAY = '2026-11-23';
const ME = { id: 1, name: 'Me' };
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

let nextId = 1000;
const todo = (o) => ({
  id: nextId++, title: `T${nextId}`, priority: 3, status: 'todo', is_done: false, parent_id: null, review_state: 'accepted',
  created_by: 1, assignee_id: null, is_member: true, watching: false, business_id: null, due_date: null, deadline_date: null,
  updated_at: ago(0), done_at: null, subtask_count: 0, subtask_done_count: 0, open_blocker_count: 0, depends_on: null, ...o,
});
const done = (daysAgo, o = {}) => todo({ is_done: true, status: 'done', done_at: ago(daysAgo), ...o });

test('businessSummary counts per business and names the one with the most open work', () => {
  const rows = [
    todo({ business_id: 1, business_name: 'Infra', assignee_id: 5 }),
    todo({ business_id: 1, business_name: 'Infra', assignee_id: 5, due_date: addDays(TODAY, -2) }), // overdue
    todo({ business_id: 1, business_name: 'Infra', assignee_id: null, status: 'blocked' }), // stuck, unassigned
    done(2, { business_id: 1, business_name: 'Infra', assignee_id: 5 }),
    done(20, { business_id: 1, business_name: 'Infra', assignee_id: 5 }), // outside a 7-day window
    todo({ business_id: 2, business_name: 'Tech', assignee_id: 6 }),
    todo({ parent_id: 1, business_id: 2, business_name: 'Tech' }), // a sub-task is not counted
    todo({}), // personal: not a business
  ];
  const s = businessSummary(rows, TODAY, 7, NOW);
  assert.strictEqual(s.most_pending, 'Infra');
  const infra = s.businesses.find((b) => b.name === 'Infra');
  assert.deepStrictEqual([infra.open, infra.overdue, infra.blocked, infra.unassigned, infra.completed], [3, 1, 1, 1, 1]);
  assert.strictEqual(infra.progress_pct, 25); // 1 done of 1 done + 3 open
  assert.strictEqual(infra.attention.length, 2);
  assert.strictEqual(s.businesses.find((b) => b.name === 'Tech').open, 1);
  assert.strictEqual(s.businesses.length, 2);
});

test('businessSummary has nothing to name when there is no business work', () => {
  const s = businessSummary([todo({})], TODAY, 7, NOW);
  assert.deepStrictEqual(s.businesses, []);
  assert.strictEqual(s.most_pending, null);
});

test('teamPerformance gives an on-time rate only from three dated to-dos', () => {
  const rows = [
    done(1, { assignee_id: 7, assignee_name: 'Ann', due_date: TODAY }), // on time
    done(2, { assignee_id: 7, assignee_name: 'Ann', due_date: addDays(TODAY, -5) }), // late
    todo({ assignee_id: 7, assignee_name: 'Ann', due_date: addDays(TODAY, -1) }), // open, overdue
    done(1, { assignee_id: 8, assignee_name: 'Bo', due_date: TODAY }),
    done(1, { assignee_id: 8, assignee_name: 'Bo', due_date: TODAY }),
    done(1, { assignee_id: 8, assignee_name: 'Bo', due_date: TODAY }),
  ];
  const t = teamPerformance(rows, TODAY, 7);
  const ann = t.find((p) => p.name === 'Ann');
  const bo = t.find((p) => p.name === 'Bo');
  assert.deepStrictEqual([ann.completed, ann.open, ann.overdue, ann.on_time_rate], [2, 1, 1, null]);
  assert.deepStrictEqual([bo.completed, bo.on_time_rate], [3, 100]);
  assert.strictEqual(t[0].name, 'Bo', 'most finished first');
});

test('prioritySuggestions follow dates and dependencies, and say why', () => {
  const blocker = todo({ priority: 4 });
  const rows = [
    todo({ title: 'late', priority: 4, due_date: addDays(TODAY, -3) }), // -> 2
    todo({ title: 'today', priority: 3, due_date: TODAY }), // -> 2
    todo({ title: 'tomorrow', priority: 4, due_date: addDays(TODAY, 1) }), // -> 3
    todo({ title: 'fine', priority: 2, due_date: TODAY }), // already high: no suggestion
    todo({ title: 'far urgent', priority: 1, due_date: addDays(TODAY, 40) }), // -> 3
    blocker,
    todo({ title: 'waits', priority: 2, depends_on: [{ id: blocker.id, is_done: false }] }),
    todo({ title: 'not editable', priority: 4, due_date: addDays(TODAY, -3), permissions: { can_edit: false } }),
  ];
  const s = prioritySuggestions(rows, ME, NOW);
  const by = (title) => s.find((x) => x.title === title);
  assert.strictEqual(by('late').priority, 2);
  assert.match(by('late').why, /Overdue by 3 days/);
  assert.strictEqual(by('today').priority, 2);
  assert.strictEqual(by('tomorrow').priority, 3);
  assert.strictEqual(by('far urgent').priority, 3);
  assert.strictEqual(by('fine'), undefined);
  assert.strictEqual(by('not editable'), undefined, 'never suggests a change the person may not make');
  const b = s.find((x) => x.id === blocker.id);
  assert.strictEqual(b.priority, 2);
  assert.match(b.why, /1 other to-do waits for this one/);
  assert.strictEqual(s[0].title, 'late', 'most urgent first');
});

test('prioritySuggestions stay quiet when nothing is off', () => {
  assert.deepStrictEqual(prioritySuggestions([todo({ priority: 3, due_date: addDays(TODAY, 5) })], ME, NOW), []);
});

test('balanceMoves only offers to-dos the person may reassign, from busy to light', () => {
  const rows = [];
  for (let i = 0; i < 8; i += 1) rows.push(todo({ business_id: 1, assignee_id: 10, assignee_name: 'Busy', permissions: { can_assign: i < 3 } }));
  rows.push(todo({ business_id: 1, assignee_id: 11, assignee_name: 'Light' }));
  rows.push(todo({ business_id: 1, assignee_id: 12, assignee_name: 'Mid' }), todo({ business_id: 1, assignee_id: 12, assignee_name: 'Mid' }));
  const wl = workload(rows, TODAY, 1);
  const moves = balanceMoves(rows, wl);
  assert.ok(moves.length >= 1 && moves.length <= 2);
  moves.forEach((m) => { assert.strictEqual(m.from, 'Busy'); assert.strictEqual(m.to, 'Light'); assert.strictEqual(m.to_id, 11); });
  const assignable = new Set(rows.filter((t) => t.permissions && t.permissions.can_assign).map((t) => t.id));
  moves.forEach((m) => assert.ok(assignable.has(m.todo_id)));
  assert.deepStrictEqual(balanceMoves(rows, { uneven: false, people: [] }), []);
});

test('suggestQuestions depend on the data and are always a short, unique list', () => {
  const empty = suggestQuestions(buildOverview([], ME, NOW), { hour: 10, businesses: 0 });
  assert.ok(empty.length >= 2 && empty.length <= 8);
  assert.ok(!empty.some((q) => /overdue/i.test(q)), 'no overdue question when nothing is overdue');
  assert.ok(!empty.includes('How are the businesses doing?'));

  const rows = [
    todo({ due_date: addDays(TODAY, -2) }), todo({ due_date: addDays(TODAY, -1) }), todo({ due_date: TODAY }),
    todo({ assignee_id: 1, created_by: 2, business_id: 3 }),
    todo({ assignee_id: 9, created_by: 1, business_id: 3, updated_at: ago(6) }),
    done(0),
  ];
  const q = suggestQuestions(buildOverview(rows, ME, NOW), { hour: 17, businesses: 2 });
  assert.ok(q.includes('Read me my plan for today'));
  assert.ok(q.includes('Show my 2 overdue tasks'));
  assert.ok(q.includes('How are the businesses doing?'));
  assert.ok(q.includes('Summarize my day and plan tomorrow'), 'an end-of-day question after 4 pm, even in a crowded list');
  assert.strictEqual(new Set(q).size, q.length);
  assert.ok(q.length <= 8, 'a crowded day still gives a short list');
  assert.ok(!suggestQuestions(buildOverview(rows, ME, NOW), { hour: 9, businesses: 2 }).includes('Summarize my day and plan tomorrow'));

  // Work given to me and by me, with nothing else going on.
  const assigned = suggestQuestions(buildOverview([
    todo({ assignee_id: 1, created_by: 2, business_id: 3, due_date: addDays(TODAY, 20) }),
    todo({ assignee_id: 9, created_by: 1, business_id: 3, due_date: addDays(TODAY, 20) }),
  ], ME, NOW), { hour: 10, businesses: 1 });
  assert.ok(assigned.includes('What tasks are assigned to me?'));
  assert.ok(assigned.includes('What tasks have I assigned to others?'));
});

test('hourNow is a real hour of the day', () => {
  const h = hourNow(NOW);
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 23);
  assert.strictEqual(hourNow(Date.parse('2026-11-23T08:00:00Z')), 13); // 13:30 in Asia/Kolkata
});

test('monthReport compares 30 days with the 30 before, week by week', () => {
  const rows = [
    done(1), done(3), done(8), done(15), done(22), done(28), // 6 in the last 30 days
    done(40), done(45), // 2 in the 30 before
    todo({ due_date: addDays(TODAY, -4), subtask_count: 3 }), // a delayed project
    todo({ due_date: addDays(TODAY, 2) }),
    done(5, { subtask_count: 4, subtask_done_count: 4 }), // a completed project
    done(100), // too old to count
  ];
  const m = monthReport(rows, ME, NOW);
  assert.strictEqual(m.period, 'month');
  assert.strictEqual(m.completed, 7);
  assert.strictEqual(m.previous_period_completed, 2);
  assert.strictEqual(m.trend, 'up');
  assert.strictEqual(m.change_pct, 250);
  assert.strictEqual(m.per_week.length, 4);
  assert.strictEqual(m.per_week.reduce((s, w) => s + w.completed, 0), m.completed, 'every finished to-do is in exactly one week');
  assert.strictEqual(m.completed_projects.length, 1);
  assert.strictEqual(m.delayed_projects.length, 1);
  assert.strictEqual(m.delayed.length, 1);
  assert.strictEqual(m.pending, 2);
  assert.strictEqual(m.next_week.length, 1);
  assert.strictEqual(m.progress_pct, 88); // 7 done of 7 done + 1 open due by today
});

test('fullReport adds business progress, team progress and areas to improve for a week and a month', () => {
  const rows = [
    done(1, { business_id: 1, business_name: 'Infra', assignee_id: 5, assignee_name: 'Ann', due_date: TODAY }),
    todo({ business_id: 1, business_name: 'Infra', assignee_id: 5, assignee_name: 'Ann', due_date: addDays(TODAY, -3) }),
    todo({ business_id: 1, business_name: 'Infra', assignee_id: 5, assignee_name: 'Ann', due_date: addDays(TODAY, -2) }),
    todo({ business_id: 1, business_name: 'Infra', assignee_id: 5, assignee_name: 'Ann', due_date: addDays(TODAY, -1) }),
    todo({ due_date: addDays(TODAY, -1) }), todo({ due_date: addDays(TODAY, -2) }), todo({ due_date: addDays(TODAY, -3) }),
  ];
  const week = fullReport(rows, ME, 'week', NOW);
  assert.strictEqual(week.period, 'week');
  assert.strictEqual(week.businesses[0].name, 'Infra');
  assert.strictEqual(week.team[0].name, 'Ann');
  assert.ok(week.focus_areas.some((f) => /overdue/.test(f)));
  assert.ok(week.focus_areas.some((f) => f.startsWith('Infra:')));
  assert.ok(Array.isArray(week.productivity_insights));
  const month = fullReport(rows, ME, 'month', NOW);
  assert.strictEqual(month.period, 'month');
  assert.ok(month.businesses.length === 1 && month.focus_areas.length > 0);
  const day = fullReport(rows, ME, 'day', NOW);
  assert.strictEqual(day.period, 'day');
  assert.strictEqual(day.businesses, undefined, 'the daily report is unchanged');
});

test('a quiet period produces no invented advice', () => {
  const r = fullReport([todo({ due_date: addDays(TODAY, 4) })], ME, 'week', NOW);
  assert.deepStrictEqual(r.focus_areas, []);
  assert.deepStrictEqual(r.businesses, []);
  assert.deepStrictEqual(r.team, []);
  assert.strictEqual(r.on_time_rate, null);
});

test('every recommendation says what, why and what to do; a break-down one names its to-do', () => {
  const rows = [
    todo({ due_date: addDays(TODAY, -2) }), // overdue
    todo({ title: 'Build the whole app', duration_minutes: 600 }), // large, no steps
  ];
  const ov = buildOverview(rows, ME, NOW);
  const recs = require('./assistantAnalytics').recommendations(ov.insights);
  const overdue = recs.find((r) => r.kind === 'overdue');
  assert.match(overdue.what, /past the date/);
  assert.ok(overdue.why && overdue.action.label && overdue.action.ask);
  const big = recs.find((r) => r.kind === 'break_down');
  assert.strictEqual(big.action.ask, 'Break down "Build the whole app" into steps');
  recs.forEach((r) => { if (r.kind !== 'all_clear') assert.ok(r.why, `${r.kind} explains why it matters`); });
  assert.deepStrictEqual(require('./assistantAnalytics').recommendations(null), []);
});

test('overviewExtras bundles businesses, priorities, balancing, recommendations and questions', () => {
  const rows = [todo({ business_id: 1, business_name: 'Infra', due_date: addDays(TODAY, -3), priority: 4 })];
  const ov = buildOverview(rows, ME, NOW);
  const x = require('./assistantAnalytics').overviewExtras(rows, ME, ov, NOW);
  assert.strictEqual(x.businesses[0].name, 'Infra');
  assert.strictEqual(x.priority_suggestions[0].priority, 2);
  assert.deepStrictEqual(x.balance_moves, []);
  assert.ok(x.recommendations.length > 0);
  assert.ok(x.questions.includes('How are the businesses doing?'));
});

test('the plan never presents a guessed time or length as an estimate', () => {
  const { withoutGuessedTimes } = require('./assistantAnalytics');
  const plan = {
    today: TODAY, planned_minutes: 90, note: 'About 1.5 hours of work, it fits the day.',
    plan: [
      { id: 1, title: 'Has a length', why: 'Due today', minutes: 60, start: '09:30', end: '10:30', priority: 2 },
      { id: 2, title: 'No length', why: 'Overdue', minutes: 30, start: '10:30', end: '11:00', priority: 3 }, // 30 is the default guess
    ],
    overflow: [{ id: 3, title: 'Also no length', why: 'Next on your list', minutes: 30, priority: 4 }],
  };
  const out = withoutGuessedTimes(plan, [{ id: 1, duration_minutes: 60 }, { id: 2, duration_minutes: null }, { id: 3 }]);
  assert.deepStrictEqual(out.plan[0], plan.plan[0], 'a real estimate is kept');
  assert.deepStrictEqual(Object.keys(out.plan[1]).sort(), ['business_name', 'due_date', 'estimate', 'id', 'priority', 'title', 'why']);
  assert.strictEqual(out.plan[1].estimate, 'not set');
  assert.ok(!('minutes' in out.plan[1]) && !('start' in out.plan[1]) && !('end' in out.plan[1]));
  assert.strictEqual(out.overflow[0].estimate, 'not set');
  assert.strictEqual(out.planned_minutes, undefined, 'the total made of guesses is dropped');
  assert.ok(!/hours/.test(out.note), 'so is the sentence made from it');
  assert.strictEqual(withoutGuessedTimes(null, []), null);
  assert.deepStrictEqual(withoutGuessedTimes({ today: TODAY }, []), { today: TODAY });
});

test('classify is unchanged by the new module', () => {
  assert.strictEqual(classify([todo({})], 1).mine.length, 1);
});
