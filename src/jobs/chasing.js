const db = require('../db');
const { notify } = require('../utils/notify');
const { loadActor, nextApprovers, actorBestLevel } = require('../utils/org');
const { APP_TIMEZONE } = require('../utils/recurrence');
const { stepGoUrl } = require('../utils/quickAction');

// Auto-chasing, so nobody has to remember to ask:
//  - a finished step waiting for a decision for a day gets a reminder (every day, for up to five days),
//  - a blocker still open after three days is passed to the next person up the chain, once,
//  - work "in progress" with no activity for three days asks its owner "still on it?" (every three days).
// Only in working hours (company time zone), Monday to Saturday.
const FROM_HOUR = 9;
const TO_HOUR = 19;
const INTERVAL_MS = 30 * 60 * 1000;

async function working() {
  const r = (await db.query(
    'SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h, EXTRACT(ISODOW FROM NOW() AT TIME ZONE $1)::int AS d', [APP_TIMEZONE]
  )).rows[0];
  return r.h >= FROM_HOUR && r.h < TO_HOUR && r.d <= 6;
}

async function chaseSteps() {
  const rows = (await db.query(
    `SELECT s.id, s.title, s.parent_id, p.title AS parent_title, p.created_by
     FROM todos s JOIN todos p ON p.id = s.parent_id
     WHERE s.step_state = 'awaiting_review' AND s.step_since < NOW() - INTERVAL '24 hours' AND s.step_since > NOW() - INTERVAL '5 days'
       AND (s.step_chased_at IS NULL OR s.step_chased_at < NOW() - INTERVAL '23 hours')`
  )).rows;
  for (const s of rows) {
    const claimed = await db.query(
      `UPDATE todos SET step_chased_at = NOW() WHERE id = $1 AND (step_chased_at IS NULL OR step_chased_at < NOW() - INTERVAL '23 hours') RETURNING id`,
      [s.id]
    );
    if (!claimed.rows.length || !s.created_by) continue;
    await notify([s.created_by], {
      type: 'step_review',
      title: 'A step is waiting for your decision',
      body: `${s.title} (${s.parent_title}) has been finished for over a day.`,
      data: { todoId: s.parent_id, stepId: s.id, quickUrl: stepGoUrl(s.id, s.created_by) },
    });
  }
}

async function escalateBlockers() {
  const rows = (await db.query(
    `SELECT b.id, b.todo_id, b.note, t.title, t.business_id, t.assignee_id, t.created_by
     FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
     WHERE b.resolved_at IS NULL AND b.escalated_at IS NULL AND b.raised_at < NOW() - INTERVAL '3 days' AND t.is_done = FALSE`
  )).rows;
  for (const b of rows) {
    const claimed = await db.query('UPDATE todo_blockers SET escalated_at = NOW() WHERE id = $1 AND escalated_at IS NULL RETURNING id', [b.id]);
    if (!claimed.rows.length) continue;
    const owner = await loadActor(b.assignee_id || b.created_by);
    const level = owner ? actorBestLevel(owner) : 9;
    const up = await nextApprovers(b.business_id, level, b.assignee_id || b.created_by);
    await notify([...new Set([...up, b.created_by].filter(Boolean))], {
      type: 'blocker_escalated',
      title: 'A roadblock has been open for 3 days',
      body: `${b.title}${b.note ? `: ${b.note}` : ''}`,
      data: { todoId: b.todo_id },
    });
  }
}

async function askIfStale() {
  const rows = (await db.query(
    `SELECT t.id, t.title, t.assignee_id FROM todos t
     WHERE t.status = 'in_progress' AND t.is_done = FALSE AND t.assignee_id IS NOT NULL
       AND t.status_since < NOW() - INTERVAL '3 days'
       AND (t.stale_chased_at IS NULL OR t.stale_chased_at < NOW() - INTERVAL '3 days')
       AND NOT EXISTS (SELECT 1 FROM todo_events e WHERE e.todo_id = t.id AND e.created_at > NOW() - INTERVAL '3 days')
     LIMIT 200`
  )).rows;
  for (const t of rows) {
    const claimed = await db.query(
      `UPDATE todos SET stale_chased_at = NOW() WHERE id = $1 AND (stale_chased_at IS NULL OR stale_chased_at < NOW() - INTERVAL '3 days') RETURNING id`,
      [t.id]
    );
    if (!claimed.rows.length) continue;
    await notify([t.assignee_id], {
      type: 'todo_stale',
      title: 'Still working on this?',
      body: `${t.title} has had no update for 3 days. Post an update, or tell us what is in the way.`,
      data: { todoId: t.id },
    });
  }
}

async function chase() {
  try {
    if (!(await working())) return;
    await chaseSteps();
    await escalateBlockers();
    await askIfStale();
  } catch (err) {
    console.error('[chasing] failed:', err.message);
  }
}

function scheduleChasing() {
  setTimeout(chase, 3 * 60 * 1000);
  setInterval(chase, INTERVAL_MS);
}

module.exports = { scheduleChasing, chase };
