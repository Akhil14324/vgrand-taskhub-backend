const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { getTodoFor, audienceIds } = require('../services/todoQueries');
const { isAssignable } = require('../services/todoGovernance');
const { BLOCKER_LABELS, logEvent, setStatus, assignTodo } = require('../services/todoTimeline');
const { createMeet, configured: meetConfigured } = require('../utils/googleMeet');

// Step reviews and meetings. Mounted next to the to-do router on /api/todos.
const router = express.Router();

async function broadcast(todoId, action = 'updated') {
  emitToUsers(await audienceIds(todoId), 'todo:changed', { todoId: Number(todoId), action });
}

async function openTodoFor(req, res) {
  const actor = await loadActor(req.user.id);
  const todo = actor ? await getTodoFor(req.params.id, actor.id, actor) : null;
  if (!todo) {
    res.status(404).json({ error: 'To-do not found' });
    return null;
  }
  req.actor = actor;
  return todo;
}

// POST /api/todos/:id/step-review — { decision, note?, user_id? } the decision on a finished step (a direct
// sub-task of a top-level to-do). The person who set the work (the parent's creator), or anyone who can edit
// the parent, decides: continue | redo | stop | delegate (the next open step goes to user_id) | roadblock
// (raises a blocker on the whole to-do).
const STEP_DECISIONS = ['continue', 'redo', 'stop', 'delegate', 'roadblock'];
const LABELS = { continue: 'Go ahead', redo: 'Redo', stop: 'Stopped', delegate: 'Handed over', roadblock: 'Roadblock' };
const AFTER = { continue: 'approved', redo: 'redo', stop: 'stopped', delegate: 'approved', roadblock: 'approved' };

router.post('/:id(\\d+)/step-review', authenticate, async (req, res, next) => {
  try {
    const step = await openTodoFor(req, res);
    if (!step) return;
    const actor = req.actor;
    const decision = req.body.decision;
    if (!STEP_DECISIONS.includes(decision)) return res.status(400).json({ error: 'Pick what happens next' });
    if (step.step_state !== 'awaiting_review') return res.status(400).json({ error: 'This step is not waiting for a decision' });
    const parent = step.parent_id ? await getTodoFor(step.parent_id, actor.id, actor) : null;
    if (!parent) return res.status(404).json({ error: 'To-do not found' });
    if (parent.created_by !== actor.id && !parent.permissions.can_edit) {
      return res.status(403).json({ error: 'Only the person who set this work can decide' });
    }
    const note = sanitizeText(req.body.note, 1000);
    if ((decision === 'redo' || decision === 'roadblock') && !note) {
      return res.status(400).json({ error: decision === 'redo' ? 'Say what to fix' : 'Describe the roadblock' });
    }
    let target = null;
    if (decision === 'delegate') {
      const userId = parseInt(req.body.user_id, 10);
      target = userId
        ? (await db.query(`SELECT id, name FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0]
        : null;
      if (!target) return res.status(400).json({ error: 'Pick who takes it from here' });
      if (parent.business_id && !(await isAssignable(target.id, parent.business_id))) {
        return res.status(400).json({ error: 'That person is not part of this business' });
      }
    }

    await db.query('UPDATE todos SET step_state = $2 WHERE id = $1', [step.id, AFTER[decision]]);
    await db.query(
      'INSERT INTO todo_step_reviews (todo_id, reviewer_id, decision, note, target_id) VALUES ($1, $2, $3, $4, $5)',
      [step.id, actor.id, decision, note || '', target ? target.id : null]
    );
    await logEvent({
      todoId: step.id, userId: actor.id, subjectId: step.assignee_id, kind: 'step_reviewed',
      to: LABELS[decision], note: [target && `to ${target.name}`, note].filter(Boolean).join(' — ') || null,
    });

    if (decision === 'redo') {
      await db.query(
        `UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL, approved_by = NULL, approved_at = NULL,
                submitted_by = NULL, submitted_at = NULL WHERE id = $1`,
        [step.id]
      );
      await setStatus(step.id, step.started_at ? 'in_progress' : 'todo');
      if (parent.is_done) {
        await db.query('UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL WHERE id = $1', [parent.id]);
        await setStatus(parent.id, 'in_progress');
      }
    } else if (decision === 'stop') {
      if (!parent.is_done) {
        await setStatus(parent.id, 'on_hold');
        await logEvent({
          todoId: parent.id, userId: actor.id, subjectId: parent.assignee_id, kind: 'status',
          from: parent.status, to: 'on_hold', note: note || 'Stopped after a step',
        });
      }
    } else if (decision === 'delegate') {
      const next = (await db.query(
        'SELECT id, title FROM todos WHERE parent_id = $1 AND is_done = FALSE ORDER BY id LIMIT 1',
        [parent.id]
      )).rows[0];
      await assignTodo(next || { id: step.id, title: step.title }, target.id, actor);
    } else if (decision === 'roadblock') {
      await db.query(
        `INSERT INTO todo_blockers (todo_id, kind, note, raised_by, mentions) VALUES ($1, 'issue', $2, $3, '[]')`,
        [parent.id, note, actor.id]
      );
      await setStatus(parent.id, 'blocked');
      await logEvent({
        todoId: parent.id, userId: actor.id, subjectId: parent.assignee_id, kind: 'blocker_raised',
        to: BLOCKER_LABELS.issue, note,
      });
    }

    const who = [...new Set([step.assignee_id, step.done_by, parent.assignee_id].filter(Boolean))];
    await notify(who, {
      type: 'step_reviewed',
      title: `${actor.name}: ${LABELS[decision]} on "${step.title}"`,
      body: note || parent.title,
      data: { todoId: parent.id },
    }, { exclude: [actor.id] });
    await broadcast(parent.id);
    await broadcast(step.id);
    res.json({ todo: await getTodoFor(step.id, actor.id, actor), parent: await getTodoFor(parent.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/:id/meetings
router.get('/:id(\\d+)/meetings', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    const rows = (await db.query(
      `SELECT m.id, m.title, m.meet_url, m.starts_at, m.ends_at, m.attendee_ids, m.created_by, u.name AS created_by_name,
              (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'name', a.name)), '[]'::json)
                 FROM users a WHERE a.id = ANY(m.attendee_ids)) AS attendees
       FROM todo_meetings m LEFT JOIN users u ON u.id = m.created_by
       WHERE m.todo_id = $1 ORDER BY m.created_at DESC LIMIT 20`,
      [todo.id]
    )).rows;
    res.json({ meetings: rows, available: meetConfigured() });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/meetings — { attendee_ids, title?, starts_at?, minutes? } makes a Google Meet link.
router.post('/:id(\\d+)/meetings', authenticate, async (req, res, next) => {
  try {
    const todo = await openTodoFor(req, res);
    if (!todo) return;
    const actor = req.actor;
    const ids = [...new Set((Array.isArray(req.body.attendee_ids) ? req.body.attendee_ids : [])
      .map(Number).filter((n) => n > 0 && n !== actor.id))].slice(0, 50);
    const people = ids.length
      ? (await db.query(`SELECT id, name, email FROM users WHERE id = ANY($1::int[]) AND status != 'inactive'`, [ids])).rows
      : [];
    const start = req.body.starts_at ? new Date(req.body.starts_at) : new Date();
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'That start time is not valid' });
    const minutes = Math.max(10, Math.min(480, parseInt(req.body.minutes, 10) || 30));
    const end = new Date(start.getTime() + minutes * 60000);
    const title = sanitizeText(req.body.title, 200) || `Meeting: ${todo.title}`;
    const me = (await db.query('SELECT email FROM users WHERE id = $1', [actor.id])).rows[0];
    const meet = await createMeet({
      title,
      description: `Meeting about the to-do "${todo.title}" in TaskHub.`,
      start,
      end,
      attendees: [me?.email, ...people.map((p) => p.email)].filter(Boolean),
      requestId: `todo-${todo.id}-${Date.now()}`,
    });
    const row = (await db.query(
      `INSERT INTO todo_meetings (todo_id, created_by, title, meet_url, event_id, starts_at, ends_at, attendee_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, title, meet_url, starts_at, ends_at, attendee_ids`,
      [todo.id, actor.id, title, meet.url, meet.eventId, start, end, people.map((p) => p.id)]
    )).rows[0];
    await logEvent({ todoId: todo.id, userId: actor.id, subjectId: todo.assignee_id, kind: 'meeting', to: title, note: meet.url });
    if (people.length) {
      await notify(people.map((p) => p.id), {
        type: 'todo_meeting',
        title: `${actor.name} started a meeting`,
        body: title,
        data: { todoId: todo.id, meetUrl: meet.url },
      });
    }
    res.status(201).json({
      meeting: { ...row, attendees: people.map((p) => ({ id: p.id, name: p.name })), created_by_name: actor.name },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
