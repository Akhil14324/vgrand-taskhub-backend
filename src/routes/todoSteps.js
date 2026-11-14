const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor } = require('../utils/org');
const { getTodoFor, audienceIds } = require('../services/todoQueries');
const { isAssignable } = require('../services/todoGovernance');
const { BLOCKER_LABELS, logEvent, setStatus, assignTodo } = require('../services/todoTimeline');
const { releaseNext } = require('../services/workflows');
const { readStepGo } = require('../utils/quickAction');

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

    if (decision === 'continue') await releaseNext(parent.id).catch((e) => console.error('[workflows] next step:', e.message));
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

// Public: POST /api/quick/step-go?t=<token> — "Go ahead" from a notification button. The signed link is the
// key (one step, one person, three days); the same rules as the app apply to who may decide.
const quick = express.Router();
async function stepGo(req, res) {
  try {
    const { stepId, userId } = readStepGo(String(req.query.t || ''));
    const actor = await loadActor(userId);
    const step = actor ? await getTodoFor(stepId, actor.id, actor) : null;
    const parent = step?.parent_id ? await getTodoFor(step.parent_id, actor.id, actor) : null;
    if (!step || !parent) return res.status(404).json({ error: 'Not found' });
    if (step.step_state !== 'awaiting_review') return res.json({ ok: true, already: true });
    if (parent.created_by !== actor.id && !parent.permissions.can_edit) return res.status(403).json({ error: 'Not allowed' });
    await db.query("UPDATE todos SET step_state = 'approved' WHERE id = $1", [step.id]);
    await db.query('INSERT INTO todo_step_reviews (todo_id, reviewer_id, decision, note) VALUES ($1, $2, $3, $4)', [step.id, actor.id, 'continue', '']);
    await logEvent({ todoId: step.id, userId: actor.id, subjectId: step.assignee_id, kind: 'step_reviewed', to: LABELS.continue });
    await releaseNext(parent.id).catch((e) => console.error('[workflows] next step:', e.message));
    await notify([...new Set([step.assignee_id, step.done_by, parent.assignee_id].filter(Boolean))], {
      type: 'step_reviewed',
      title: `${actor.name}: ${LABELS.continue} on "${step.title}"`,
      body: parent.title,
      data: { todoId: parent.id },
    }, { exclude: [actor.id] });
    await broadcast(parent.id);
    await broadcast(step.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'This link has expired' });
  }
}
quick.post('/step-go', stepGo);

module.exports = router;
module.exports.quick = quick;
