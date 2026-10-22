const db = require('../db');
const { loadActor } = require('../utils/org');
const { todayInAppZone, advance } = require('../utils/recurrence');

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi;

/** "GST filing - March 2026" -> "gst filing": the same work in another month has the same key. */
const keyOf = (title) => String(title || '').toLowerCase().replace(MONTHS, ' ').replace(/\d+/g, ' ').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameOf = (title) => {
  const cleaned = String(title || '').replace(MONTHS, '').replace(/\b20\d\d\b/g, '').replace(/\s+/g, ' ').replace(/[\s\-,/]+$/g, '').trim();
  return cleaned || String(title || '');
};

const ymd = (v) => String(v).slice(0, 10);
const dayDiff = (a, b) => Math.round((new Date(`${ymd(b)}T12:00:00Z`) - new Date(`${ymd(a)}T12:00:00Z`)) / 86400000);
const median = (xs) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const addDays = (d, n) => { const x = new Date(`${ymd(d)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthName = (d) => new Date(`${ymd(d)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Work this person keeps doing: finished to-dos with steps whose names match apart from the month, done at a
 * steady rhythm. Returns ready-to-save workflow suggestions (most repeated first).
 */
async function suggestions(userId) {
  const rows = (await db.query(
    `SELECT t.id, t.title, t.business_id, t.due_date, t.done_at::date AS done_day, t.created_at::date AS made_day,
            COALESCE(json_agg(json_build_object('title', c.title, 'assignee_id', c.assignee_id, 'due_date', c.due_date) ORDER BY c.id)
              FILTER (WHERE c.id IS NOT NULL), '[]') AS steps
     FROM todos t JOIN todo_members tm ON tm.todo_id = t.id AND tm.user_id = $1
     JOIN todos c ON c.parent_id = t.id
     WHERE t.parent_id IS NULL AND t.is_done = TRUE AND t.done_at > NOW() - INTERVAL '240 days' AND t.workflow_id IS NULL
     GROUP BY t.id ORDER BY t.done_at`,
    [userId]
  )).rows;
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r.title);
    if (k.length < 4) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const taken = new Set((await db.query('SELECT name FROM workflows WHERE owner_id = $1', [userId])).rows.map((w) => keyOf(w.name)));
  const today = todayInAppZone();
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2 || taken.has(k)) continue;
    const days = list.map((r) => ymd(r.due_date || r.done_day || r.made_day));
    const gap = median(days.slice(1).map((d, i) => dayDiff(days[i], d)).filter((g) => g > 0));
    const recurrence = gap >= 5 && gap <= 9 ? 'weekly' : gap >= 24 && gap <= 38 ? 'monthly' : null;
    if (!recurrence) continue;
    const last = list[list.length - 1];
    const base = ymd(last.due_date || last.done_day);
    const steps = last.steps.map((s) => ({
      title: s.title,
      assignee_id: s.assignee_id || null,
      offset_days: s.due_date && last.due_date ? Math.max(0, dayDiff(last.due_date, s.due_date)) : 0,
    }));
    let next = advance(base, recurrence);
    while (next <= today) next = advance(next, recurrence);
    out.push({ name: nameOf(last.title), recurrence, steps, business_id: last.business_id || null, occurrences: list.length, next_run_date: next });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences).slice(0, 8);
}

async function addStep(actor, parentId, steps, index, runDate) {
  const { createTodoCore } = require('../routes/todos');
  const s = steps[index];
  if (!s) return null;
  const body = { title: s.title, parent_id: parentId, due_date: addDays(runDate, Number(s.offset_days) || 0) };
  if (s.assignee_id) { body.assign_to = s.assignee_id; body.mention_ids = [s.assignee_id]; }
  const out = await createTodoCore(actor, body, { quiet: true });
  return out.todo || null;
}

/** Create this round of a workflow (the to-do and its steps) for its owner. */
async function spawn(wf, { advanceSchedule = true } = {}) {
  const { createTodoCore, announce } = require('../routes/todos');
  const actor = await loadActor(wf.owner_id);
  if (!actor) return null;
  const run = ymd(wf.next_run_date);
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const lastOffset = Math.max(0, ...steps.map((s) => Number(s.offset_days) || 0));
  const title = wf.recurrence === 'monthly' ? `${wf.name} - ${monthName(run)}` : `${wf.name} - ${run}`;
  const created = await createTodoCore(actor, {
    title,
    business_id: wf.business_id || undefined,
    due_date: addDays(run, lastOffset),
    assign_to: wf.business_id ? actor.id : undefined,
  }, { quiet: true });
  if (!created.todo) throw new Error(created.error || 'Could not start the workflow');
  const parent = created.todo;
  await db.query('UPDATE todos SET workflow_id = $2, workflow_next = $3 WHERE id = $1', [parent.id, wf.id, wf.sequential ? 1 : null]);
  const first = wf.sequential ? Math.min(1, steps.length) : steps.length;
  for (let i = 0; i < first; i += 1) await addStep(actor, parent.id, steps, i, run);
  if (advanceSchedule) {
    await db.query('UPDATE workflows SET next_run_date = $2, last_run_at = NOW() WHERE id = $1', [wf.id, advance(run, wf.recurrence)]);
  }
  await announce(parent.id).catch(() => {});
  return parent;
}

/** After a step is approved: in a one-step-at-a-time workflow the next step is created now. */
async function releaseNext(parentId) {
  const row = (await db.query(
    `SELECT t.id AS todo_id, t.workflow_next, t.due_date AS todo_due, w.owner_id, w.steps
     FROM todos t JOIN workflows w ON w.id = t.workflow_id WHERE t.id = $1 AND t.workflow_next IS NOT NULL`,
    [parentId]
  )).rows[0];
  if (!row) return null;
  const steps = Array.isArray(row.steps) ? row.steps : [];
  if (row.workflow_next >= steps.length) {
    await db.query('UPDATE todos SET workflow_next = NULL WHERE id = $1', [parentId]);
    return null;
  }
  const claimed = await db.query(
    'UPDATE todos SET workflow_next = workflow_next + 1 WHERE id = $1 AND workflow_next = $2 RETURNING id', [parentId, row.workflow_next]
  );
  if (!claimed.rows.length) return null;
  const actor = await loadActor(row.owner_id);
  const lastOffset = Math.max(0, ...steps.map((s) => Number(s.offset_days) || 0));
  const run = row.todo_due ? addDays(row.todo_due, -lastOffset) : todayInAppZone();
  return addStep(actor, parentId, steps, row.workflow_next, run);
}

module.exports = { suggestions, spawn, releaseNext, keyOf };
