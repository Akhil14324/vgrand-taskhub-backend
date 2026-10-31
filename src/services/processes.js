const db = require('../db');

/**
 * Processes and their steps. A task (a process) is made of sub-tasks; its steps (events) are the lowest-level
 * sub-tasks. This measures how far a process has got, and whether it has stalled. The same rules are in the app
 * (src/utils/progress.js), keep the two in step; the pure part here is unit-tested.
 *
 * Progress is weighted by time: a step with an estimate (duration_minutes) counts for its minutes, a step
 * without one counts for the average of the estimated ones (or 1 when none has an estimate). So a 4 hour
 * step weighs more than a 15 minute one.
 *
 * Stalled: open, at least two steps, not all done, no step finished (and the task not made) for STALL_DAYS or
 * more, and either its date is within a week (or past) or, with no date, it has been quiet for twice as long.
 */
const STALL_DAYS = 3;
const SOON_DAYS = 7;

/** leaves: [{ is_done, duration_minutes, done_at }]. Returns { total, done, pct, weighted, lastStepAt }. */
function measure(leaves) {
  const known = leaves.map((l) => Number(l.duration_minutes)).filter((m) => m > 0);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const weight = (l) => (Number(l.duration_minutes) > 0 ? Number(l.duration_minutes) : avg);
  let all = 0;
  let got = 0;
  let lastStepAt = null;
  for (const l of leaves) {
    const w = weight(l);
    all += w;
    if (l.is_done) {
      got += w;
      if (l.done_at && (!lastStepAt || new Date(l.done_at) > new Date(lastStepAt))) lastStepAt = l.done_at;
    }
  }
  return {
    total: leaves.length,
    done: leaves.filter((l) => l.is_done).length,
    pct: all ? Math.round((got / all) * 100) : 0,
    weighted: known.length > 0,
    lastStepAt,
  };
}

const DAY = 86400000;

/** { idleDays, stalled } for one open process. `today` is 'YYYY-MM-DD', `now` a Date (injectable for tests). */
function stallOf({ total, done, lastStepAt }, root, now = new Date()) {
  const since = [lastStepAt, root.created_at].filter(Boolean).map((d) => new Date(d).getTime()).sort((a, b) => b - a)[0] || now.getTime();
  const idleDays = Math.max(0, Math.floor((now.getTime() - since) / DAY));
  if (total < 2 || done >= total || idleDays < STALL_DAYS) return { idleDays, stalled: false };
  const due = root.due_date ? new Date(`${String(root.due_date).slice(0, 10)}T00:00:00Z`).getTime() : null;
  const daysToDue = due === null ? null : Math.floor((due - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / DAY);
  const urgent = daysToDue !== null ? daysToDue <= SOON_DAYS : idleDays >= STALL_DAYS * 2;
  return { idleDays, stalled: urgent, daysToDue };
}

/** Every open top-level task that has steps (optionally only those assigned to these people), measured. */
async function openProcesses({ userIds = null, now = new Date() } = {}) {
  const rows = (await db.query(
    `WITH RECURSIVE tree AS (
       SELECT t.id, t.id AS root FROM todos t
       WHERE t.parent_id IS NULL AND NOT t.is_done AND t.assignee_id IS NOT NULL AND ($1::int[] IS NULL OR t.assignee_id = ANY($1::int[]))
       UNION ALL
       SELECT c.id, tree.root FROM todos c JOIN tree ON c.parent_id = tree.id
     )
     SELECT r.id AS root_id, r.title, r.assignee_id, r.created_by, r.created_at, r.due_date::text AS due_date, r.business_id,
            l.id AS leaf_id, l.is_done, l.duration_minutes, l.done_at
     FROM tree
     JOIN todos r ON r.id = tree.root
     JOIN todos l ON l.id = tree.id AND tree.id <> tree.root
     WHERE NOT EXISTS (SELECT 1 FROM todos k WHERE k.parent_id = l.id)`,
    [userIds]
  )).rows;
  const byRoot = new Map();
  for (const r of rows) {
    if (!byRoot.has(r.root_id)) byRoot.set(r.root_id, { root: r, leaves: [] });
    byRoot.get(r.root_id).leaves.push(r);
  }
  return [...byRoot.values()].map(({ root, leaves }) => {
    const m = measure(leaves);
    return {
      id: root.root_id, title: root.title, assignee_id: root.assignee_id, created_by: root.created_by,
      due_date: root.due_date, business_id: root.business_id, ...m, ...stallOf(m, root, now),
    };
  });
}

module.exports = { STALL_DAYS, SOON_DAYS, measure, stallOf, openProcesses };
