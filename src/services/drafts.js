const db = require('../db');
const { loadActor, isLeader } = require('../utils/org');
const { notify } = require('../utils/notify');
const { createTodoCore, announce } = require('../routes/todos');
const { guessBusiness, summarizeByPerson } = require('../utils/drafts');

/**
 * Drafts (migration 056): tasks found in a meeting or a message, waiting for the recorder to confirm them.
 * Nothing becomes a to-do until confirm(); confirmed ones can be undone for a minute.
 */

const UNDO_WINDOW_MS = 60 * 1000;

/** Who belongs where, for guessing a draft's company. */
async function membershipMap() {
  const rows = (await db.query(
    `SELECT u.id, u.org_level, u.role, COALESCE(array_agg(ub.business_id) FILTER (WHERE ub.business_id IS NOT NULL), '{}') AS businesses
     FROM users u LEFT JOIN user_businesses ub ON ub.user_id = u.id
     WHERE u.status != 'inactive' GROUP BY u.id`
  )).rows;
  const memberships = new Map(rows.map((r) => [r.id, r.businesses.map(Number)]));
  const leaders = new Set(rows.filter((r) => (r.org_level && r.org_level <= 3) || r.role === 'admin' || r.role === 'super_admin').map((r) => r.id));
  return { memberships, leaders };
}

/** Spelling hint for the transcriber: everyone's names, the companies and the sites. */
async function vocabulary() {
  const [people, places] = await Promise.all([
    db.query(`SELECT name FROM users WHERE status != 'inactive' ORDER BY name LIMIT 120`),
    db.query(`SELECT name FROM businesses UNION SELECT name FROM sites WHERE archived_at IS NULL`),
  ]);
  return `Names: ${people.rows.map((r) => r.name).join(', ')}. Places: ${places.rows.map((r) => r.name).join(', ')}.`;
}

/**
 * Replace a meeting's waiting drafts with a new reading of it. Drafts already confirmed stay, and a task
 * with the same title as a confirmed one is not drafted twice.
 */
async function saveMeetingDrafts(meeting, ownerId, tasks) {
  const { memberships, leaders } = await membershipMap();
  const done = new Set((await db.query(
    `SELECT lower(title) AS t FROM todo_drafts WHERE meeting_id = $1 AND status = 'created'`, [meeting.id]
  )).rows.map((r) => r.t));
  await db.query(
    `UPDATE todo_drafts SET status = 'dropped', decided_at = NOW() WHERE meeting_id = $1 AND status = 'draft'`, [meeting.id]
  );
  let position = 0;
  for (const t of tasks) {
    if (done.has(t.title.toLowerCase())) continue;
    position += 1;
    await db.query(
      `INSERT INTO todo_drafts (owner_id, meeting_id, source, title, quote, assignee_id, assignee_said, confidence,
                                business_id, due_date, due_time, priority, position)
       VALUES ($1, $2, 'meeting', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        ownerId, meeting.id, t.title, t.quote || '', t.assignee_id, t.assignee_said, t.confidence,
        guessBusiness({ assigneeId: t.assignee_id, meetingBusinessId: meeting.business_id, memberships, leaders }),
        t.due_date, t.due_time, t.priority, position,
      ]
    );
  }
  return position;
}

async function draftsFor(ownerId, { meetingId = null, status = 'draft' } = {}) {
  const rows = (await db.query(
    `SELECT d.*, to_char(d.due_time, 'HH24:MI') AS due_time, u.name AS assignee_name, u.username AS assignee_username,
            b.name AS business_name, m.title AS meeting_title
     FROM todo_drafts d
     LEFT JOIN users u ON u.id = d.assignee_id
     LEFT JOIN businesses b ON b.id = d.business_id
     LEFT JOIN meeting_notes m ON m.id = d.meeting_id
     WHERE d.owner_id = $1 AND d.status = $2 AND ($3::int IS NULL OR d.meeting_id = $3)
     ORDER BY d.meeting_id NULLS LAST, d.position, d.id`,
    [ownerId, status, meetingId]
  )).rows;
  const names = new Map(rows.filter((r) => r.assignee_id).map((r) => [r.assignee_id, r.assignee_name]));
  return { drafts: rows, summary: summarizeByPerson(rows, (id) => names.get(id)) };
}

/**
 * Create the chosen drafts as to-dos through the normal path (every rule applies), quietly, then tell each
 * person once: "Akhil gave you 34 tasks from Monday review". Returns what was made and what was refused.
 */
async function confirm(ownerId, ids) {
  const actor = await loadActor(ownerId);
  const rows = (await db.query(
    `SELECT d.*, to_char(d.due_time, 'HH24:MI') AS due_time_text, m.title AS meeting_title
     FROM todo_drafts d LEFT JOIN meeting_notes m ON m.id = d.meeting_id
     WHERE d.owner_id = $1 AND d.status = 'draft' AND d.id = ANY($2::int[]) ORDER BY d.position, d.id`,
    [ownerId, ids]
  )).rows;
  const created = [];
  const failed = [];
  const perPerson = new Map();
  for (const d of rows) {
    if (d.confidence === 'unsure' && !d.assignee_id) { failed.push({ id: d.id, error: 'Pick a person first' }); continue; }
    const body = {
      title: d.title,
      notes: d.quote ? `From the meeting: "${d.quote}"` : '',
      due_date: d.due_date || undefined,
      due_time: d.due_time_text || undefined,
      priority: d.priority || undefined,
    };
    if (d.business_id) {
      body.business_id = d.business_id;
      if (d.assignee_id) body.assign_to = d.assignee_id;
    } else if (d.assignee_id) {
      body.delegate_to = d.assignee_id;
    }
    const out = await createTodoCore(actor, body, { quiet: true });
    if (out.error) { failed.push({ id: d.id, error: out.error }); continue; }
    const todoId = out.todo?.id || out.id;
    await db.query(`UPDATE todo_drafts SET status = 'created', todo_id = $2, decided_at = NOW() WHERE id = $1`, [d.id, todoId]);
    created.push({ id: d.id, todo_id: todoId });
    await announce(todoId, 'created');
    if (d.assignee_id && d.assignee_id !== ownerId) {
      const p = perPerson.get(d.assignee_id) || { count: 0, meeting: d.meeting_title, first: d.title };
      p.count += 1;
      perPerson.set(d.assignee_id, p);
    }
  }
  for (const [userId, p] of perPerson) {
    await notify([userId], {
      type: 'todo_assigned',
      title: p.count === 1 ? `${actor.name} gave you a task` : `${actor.name} gave you ${p.count} tasks`,
      body: p.meeting ? `From ${p.meeting}${p.count === 1 ? `: ${p.first}` : ''}` : p.first,
      data: { screen: 'MyWork' },
    });
  }
  return { created, failed };
}

/**
 * Undo a confirm within a minute: the to-dos it just made are removed (a copy stays in deleted_rows) and the
 * drafts wait again. Only to-dos nobody has touched since (no comments, not finished) are taken back.
 */
async function undo(ownerId, ids) {
  const rows = (await db.query(
    `SELECT d.id, d.todo_id FROM todo_drafts d JOIN todos t ON t.id = d.todo_id
     WHERE d.owner_id = $1 AND d.status = 'created' AND d.id = ANY($2::int[])
       AND d.decided_at > NOW() - ($3::int * INTERVAL '1 millisecond')
       AND NOT t.is_done AND NOT EXISTS (SELECT 1 FROM todo_comments c WHERE c.todo_id = t.id)`,
    [ownerId, ids, UNDO_WINDOW_MS]
  )).rows;
  for (const r of rows) {
    await db.query(`UPDATE todo_drafts SET status = 'draft', todo_id = NULL, decided_at = NULL WHERE id = $1`, [r.id]);
    // Tell everyone who can see it first: once it is gone there is no audience to look up.
    await announce(r.todo_id, 'deleted');
    await db.query('DELETE FROM todos WHERE id = $1 AND created_by = $2', [r.todo_id, ownerId]);
  }
  return { undone: rows.length };
}

module.exports = { vocabulary, saveMeetingDrafts, draftsFor, confirm, undo, membershipMap, UNDO_WINDOW_MS, isLeader };
