const db = require('../db');
const { listTodos } = require('./todoQueries');
const { todayInAppZone } = require('../utils/recurrence');
const { DEFAULT_TASK_MIN, WORK_DAY_MIN } = require('../utils/insights');

// Early warning: which open to-dos are likely to miss their date, and why. It uses plain arithmetic on
// things the app already knows: how much work each person has due before the date versus the working days
// left, whether it has started, and how far this person's past work ran over their own estimates.
const WINDOW_DAYS = 7;

const ymd = (v) => String(v).slice(0, 10);
const dayDiff = (a, b) => Math.round((new Date(`${ymd(b)}T12:00:00Z`) - new Date(`${ymd(a)}T12:00:00Z`)) / 86400000);
const median = (xs) => { const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

/** Working days (Mon to Sat) from today up to and including `due`. */
function workdaysLeft(today, due) {
  let n = 0;
  const d = new Date(`${today}T12:00:00Z`);
  const end = dayDiff(today, due);
  for (let i = 0; i <= end; i += 1) {
    if (d.getUTCDay() !== 0) n += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/** assignee id -> how many times longer than estimated their finished work took (1 when there is too little history). */
async function overrunFactors() {
  const rows = (await db.query(
    `SELECT (meta->>'assignee_id')::int AS who, (meta->>'active_s')::float AS active_s, (meta->>'estimate_min')::float AS est
     FROM todo_events WHERE kind = 'completed' AND created_at > NOW() - INTERVAL '120 days'
       AND meta->>'estimate_min' IS NOT NULL AND meta->>'active_s' IS NOT NULL`
  )).rows;
  const by = new Map();
  for (const r of rows) {
    if (!r.who || !r.est || r.active_s <= 0) continue;
    if (!by.has(r.who)) by.set(r.who, []);
    by.get(r.who).push(r.active_s / (r.est * 60));
  }
  const out = new Map();
  for (const [who, xs] of by) if (xs.length >= 3) out.set(who, Math.max(0.6, Math.min(4, median(xs))));
  return out;
}

/**
 * Open to-dos in the next week that look unlikely to be ready, for the ones this person owns, set, or can edit
 * in a business. Returns [{ id, title, due, days_left, level: 'high' | 'medium', reasons: [..], assignee_name, business_name }].
 */
async function atRisk(actor) {
  const today = todayInAppZone();
  const rows = await listTodos(actor.id, {
    actor,
    where: `t.is_done = FALSE AND t.review_state = 'accepted' AND t.status <> 'on_hold'
      AND COALESCE(t.deadline_date, t.due_date) IS NOT NULL
      AND COALESCE(t.deadline_date, t.due_date) <= ($5::date + ${WINDOW_DAYS}) AND COALESCE(t.deadline_date, t.due_date) >= $5::date`,
    params: [today],
  });
  const factors = await overrunFactors();
  const mine = rows.filter((t) => t.assignee_id === actor.id || t.created_by === actor.id || (t.business_id && t.permissions && t.permissions.can_edit));

  // Everything each person has open and due in the window, to compare against the time they have.
  const open = rows;
  const minutesOf = (t) => (t.duration_minutes || DEFAULT_TASK_MIN) * (factors.get(t.assignee_id) || 1);

  const out = [];
  for (const t of mine) {
    const owner = t.assignee_id || t.created_by;
    const due = ymd(t.deadline_date || t.due_date);
    const left = workdaysLeft(today, due);
    const daysLeft = dayDiff(today, due);
    const load = open
      .filter((o) => (o.assignee_id || o.created_by) === owner && ymd(o.deadline_date || o.due_date) <= due && !o.parent_id)
      .reduce((s, o) => s + minutesOf(o), 0);
    const ratio = load / Math.max(1, left * WORK_DAY_MIN);
    const factor = factors.get(owner) || 1;
    const reasons = [];
    let score = 0;
    if (ratio > 1) { reasons.push(`${Math.round(load / 60)} hours of work is due by then and there is time for about ${Math.round((left * WORK_DAY_MIN) / 60)}`); score += ratio > 1.4 ? 3 : 2; }
    if (t.status === 'todo' && daysLeft <= 2) { reasons.push(daysLeft === 0 ? 'Due today and not started' : `Not started, due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`); score += daysLeft <= 1 ? 3 : 2; }
    if (t.status === 'blocked') { reasons.push('It is blocked'); score += daysLeft <= 3 ? 3 : 1; }
    if (factor >= 1.4 && daysLeft <= 4) { reasons.push(`Their work usually takes ${factor.toFixed(1)}x the estimate`); score += 1; }
    if (!reasons.length || score < 2) continue;
    out.push({
      id: t.id,
      title: t.title,
      due,
      days_left: daysLeft,
      level: score >= 3 ? 'high' : 'medium',
      reasons,
      assignee_id: t.assignee_id,
      assignee_name: t.assignee_name || null,
      created_by: t.created_by,
      business_name: t.business_name || null,
    });
  }
  return out.sort((a, b) => (a.level === b.level ? a.days_left - b.days_left : a.level === 'high' ? -1 : 1)).slice(0, 25);
}

module.exports = { atRisk, WINDOW_DAYS };
