const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor } = require('../utils/org');
const { notify } = require('../utils/notify');
const { listTodos } = require('../services/todoQueries');
const { logEvent, setStatus, resolveOpenBlockers } = require('../services/todoTimeline');
const { DECISIONS, ownerIdOf, submitProblem, decideProblem, groupReviews } = require('../services/taskReviews');
const { announce, finishTodo } = require('./todos');

// /api/reviews — Review & Approval. A task owner sends a task to a chosen registered person; only that reviewer
// approves it (the task becomes Done through the normal completion), asks for changes or rejects it. The task is
// the ordinary to-do; task_reviews (migration 076) only records the rounds, comments, decisions and times.
const router = express.Router();

/** One review row joined with what the lists show about its task. `$1`.. are the caller's. */
const REVIEW_SELECT = `
  SELECT r.id, r.todo_id, r.round, r.status, r.submitted_by, r.submitter_name, r.reviewer_id, r.reviewer_name,
         r.submit_note, r.submitted_at, r.decision_note, r.decided_at,
         t.title AS task_title, t.priority, t.status AS task_status, t.is_done AS task_done, t.due_date,
         COALESCE(t.assignee_id, t.created_by) AS task_owner_id, COALESCE(au.name, cu.name) AS assigned_to,
         b.name AS business_name,
         (r.id = (SELECT MAX(x.id) FROM task_reviews x WHERE x.todo_id = r.todo_id)) AS is_latest
  FROM task_reviews r
  JOIN todos t ON t.id = r.todo_id
  JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users au ON au.id = t.assignee_id
  LEFT JOIN businesses b ON b.id = t.business_id`;

/**
 * A task can be moved by the ordinary task screens while it is with a reviewer (taken back, finished with its
 * parent, ...). Such a review is closed as "withdrawn", so the lists never show work that is no longer waiting.
 */
async function closeStale() {
  await db.query(
    `UPDATE task_reviews r SET status = 'withdrawn', decided_at = NOW(),
            decision_note = CASE WHEN r.reviewer_id IS NULL THEN 'The reviewer is no longer registered' ELSE 'The task was changed outside the review' END
     FROM todos t
     WHERE r.todo_id = t.id AND r.status = 'pending'
       AND (r.reviewer_id IS NULL OR t.is_done OR t.status <> 'in_review' OR t.submitted_at > r.submitted_at)`
  );
}

const fail = (res, problem) => res.status(problem.status).json({ error: problem.error });

/** The to-do as the first of these people who can see it does (the app's own visibility), or null. */
async function todoAsSeenBy(todoId, userIds) {
  for (const uid of userIds.filter(Boolean)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await listTodos(uid, { where: 't.id = $5', params: [todoId], dumped: 'any', watching: 'any' });
    if (rows[0]) return rows[0];
  }
  return null;
}

const reviewById = async (id) => (await db.query(`${REVIEW_SELECT} WHERE r.id = $1`, [id])).rows[0] || null;

// GET /api/reviews — the six lists of the Review page, for the signed-in person.
router.get('/', authenticate, async (req, res, next) => {
  try {
    await closeStale();
    const rows = (await db.query(
      `${REVIEW_SELECT} WHERE r.submitted_by = $1 OR r.reviewer_id = $1 ORDER BY r.id DESC LIMIT 500`, [req.user.id]
    )).rows;
    res.json(groupReviews(rows, req.user.id));
  } catch (err) {
    next(err);
  }
});

// GET /api/reviews/people — registered people who can be chosen as reviewer (not me).
router.get('/people', authenticate, async (req, res, next) => {
  try {
    const people = (await db.query(
      `SELECT id, name, username, profile_picture FROM users WHERE status <> 'inactive' AND id <> $1 ORDER BY name`, [req.user.id]
    )).rows;
    res.json({ people });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviews/tasks — my open tasks that can be sent for review, with how their last review ended.
router.get('/tasks', authenticate, async (req, res, next) => {
  try {
    await closeStale();
    const actor = await loadActor(req.user.id);
    const rows = await listTodos(actor.id, {
      actor,
      where: `t.is_done = FALSE AND t.review_state = 'accepted' AND COALESCE(t.assignee_id, t.created_by) = $1
        AND NOT EXISTS (SELECT 1 FROM task_reviews r WHERE r.todo_id = t.id AND r.status = 'pending')`,
      tail: 'ORDER BY t.due_date NULLS LAST, t.id DESC LIMIT 500',
    });
    const mine = rows.filter((t) => !submitProblem(t, actor.id, false));
    const ids = mine.map((t) => t.id);
    const last = ids.length ? (await db.query(
      `SELECT DISTINCT ON (todo_id) todo_id, status, decision_note, reviewer_id, reviewer_name
       FROM task_reviews WHERE todo_id = ANY($1::int[]) ORDER BY todo_id, id DESC`, [ids]
    )).rows : [];
    const lastBy = new Map(last.map((r) => [r.todo_id, r]));
    res.json({
      tasks: mine.map((t) => ({
        id: t.id, title: t.title, priority: t.priority, status: t.status, due_date: t.due_date,
        business_name: t.business_name || null, parent_id: t.parent_id, last_review: lastBy.get(t.id) || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviews/:id — one review with the complete task details and every round. Only for the people in the
// task's reviews and its owner; it does not change who sees the task anywhere else.
router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    await closeStale();
    const review = await reviewById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    const rounds = (await db.query(`${REVIEW_SELECT} WHERE r.todo_id = $1 ORDER BY r.id`, [review.todo_id])).rows;
    const uid = req.user.id;
    const takesPart = review.task_owner_id === uid || rounds.some((r) => r.reviewer_id === uid || r.submitted_by === uid);
    if (!takesPart) return res.status(404).json({ error: 'Review not found' });

    const [task, subtasks, comments, files] = await Promise.all([
      db.query(
        `SELECT t.id, t.title, t.notes, t.priority, t.status, t.is_done, t.due_date, t.due_time, t.deadline_date, t.labels, t.recurrence,
                t.created_at, cu.name AS created_by_name, au.name AS assignee_name, b.name AS business_name, p.title AS parent_title
         FROM todos t JOIN users cu ON cu.id = t.created_by LEFT JOIN users au ON au.id = t.assignee_id
         LEFT JOIN businesses b ON b.id = t.business_id LEFT JOIN todos p ON p.id = t.parent_id WHERE t.id = $1`, [review.todo_id]
      ),
      db.query(
        `SELECT s.id, s.title, s.is_done, s.parent_id, u.name AS assignee_name FROM todos s LEFT JOIN users u ON u.id = s.assignee_id
         WHERE s.id IN (WITH RECURSIVE tree AS (SELECT id FROM todos WHERE parent_id = $1 UNION ALL SELECT c.id FROM todos c JOIN tree ON c.parent_id = tree.id) SELECT id FROM tree)
         ORDER BY s.id`, [review.todo_id]
      ),
      db.query(
        `SELECT c.id, c.body, c.created_at, u.name AS author FROM todo_comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.todo_id = $1 ORDER BY c.created_at, c.id LIMIT 200`, [review.todo_id]
      ),
      db.query(
        `SELECT id, comment_id, url, filename, mime, size_bytes FROM todo_attachments WHERE todo_id = $1 AND draft = FALSE ORDER BY id`, [review.todo_id]
      ),
    ]);
    res.json({
      review: { ...review, can_decide: review.status === 'pending' && review.reviewer_id === uid, can_resubmit: review.status === 'changes_requested' && review.is_latest && !review.task_done && review.task_owner_id === uid },
      task: task.rows[0],
      subtasks: subtasks.rows,
      comments: comments.rows,
      files: files.rows,
      rounds,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/reviews — { todo_id, reviewer_id, note? } send (or send again) my task to a reviewer.
router.post('/', authenticate, async (req, res, next) => {
  try {
    await closeStale();
    const actor = await loadActor(req.user.id);
    const todoId = parseInt(req.body.todo_id, 10);
    const reviewerId = parseInt(req.body.reviewer_id, 10);
    if (!todoId) return res.status(400).json({ error: 'Choose a task' });
    if (!reviewerId) return res.status(400).json({ error: 'Choose a reviewer' });

    const todo = await todoAsSeenBy(todoId, [actor.id]);
    if (!todo) return res.status(404).json({ error: 'Task not found' });
    const pending = (await db.query(`SELECT 1 FROM task_reviews WHERE todo_id = $1 AND status = 'pending'`, [todo.id])).rows.length > 0;
    const problem = submitProblem(todo, actor.id, pending);
    if (problem) return fail(res, problem);

    if (reviewerId === actor.id) return res.status(400).json({ error: 'Choose someone else as the reviewer' });
    const reviewer = (await db.query(`SELECT id, name FROM users WHERE id = $1 AND status <> 'inactive'`, [reviewerId])).rows[0];
    if (!reviewer) return res.status(404).json({ error: 'That person was not found' });

    // The same rule as ticking a task: required board columns must be filled before it can be finished.
    if (todo.status !== 'in_review' && todo.board_id) {
      const empty = (await db.query(
        `SELECT c.title FROM board_columns c
         WHERE c.board_id = $1 AND c.archived_at IS NULL AND c.system_key IS NULL AND (c.settings->>'required')::boolean
           AND NOT EXISTS (SELECT 1 FROM item_values v WHERE v.column_id = c.id AND v.todo_id = $2)
         ORDER BY c.sort_order`,
        [todo.board_id, todo.id]
      )).rows.map((r) => r.title);
      if (empty.length) return res.status(400).json({ error: `Fill ${empty.join(', ')} before sending it for review` });
    }

    const note = sanitizeText(req.body.note, 2000) || null;
    const now = new Date();
    let created;
    try {
      created = (await db.query(
        `INSERT INTO task_reviews (todo_id, round, submitted_by, submitter_name, reviewer_id, reviewer_name, submit_note, submitted_at)
         VALUES ($1, (SELECT COUNT(*) + 1 FROM task_reviews WHERE todo_id = $1), $2, $3, $4, $5, $6, $7) RETURNING id, round`,
        [todo.id, actor.id, actor.name, reviewer.id, reviewer.name, note, now]
      )).rows[0];
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'This task is already with a reviewer' });
      throw err;
    }

    // The task itself goes "In review", exactly as when finished work is sent for review elsewhere in the app.
    await db.query('UPDATE todos SET submitted_by = $1, submitted_at = $2, approved_by = NULL, approved_at = NULL WHERE id = $3', [actor.id, now, todo.id]);
    await resolveOpenBlockers(todo.id, actor.id, 'Sent for review');
    const moved = await setStatus(todo.id, 'in_review');
    await logEvent({
      todoId: todo.id, userId: actor.id, subjectId: todo.assignee_id, kind: 'submitted', from: moved.from, to: 'in_review',
      note: `Reviewer: ${reviewer.name}${note ? `. ${note}` : ''}`,
    });
    await notify([reviewer.id], {
      type: 'approval_request',
      title: created.round > 1 ? `${actor.name} sent a task to you for review again` : `${actor.name} sent you a task to review`,
      body: todo.title,
      data: { todoId: todo.id, reviewId: created.id, screen: 'Review' },
    }, { exclude: [actor.id] });

    await announce(todo.id);
    res.status(201).json({ review: await reviewById(created.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/reviews/:id/approve { note? } | /changes { note } | /reject { note } — the assigned reviewer only.
router.post('/:id(\\d+)/:decision(approve|changes|reject)', authenticate, async (req, res, next) => {
  try {
    await closeStale();
    const actor = await loadActor(req.user.id);
    const { decision } = req.params;
    const review = await reviewById(req.params.id);
    // Someone with no part in the review learns nothing about it.
    if (!review || (review.reviewer_id !== actor.id && review.submitted_by !== actor.id && review.task_owner_id !== actor.id)) {
      return res.status(404).json({ error: 'Review not found' });
    }
    const note = sanitizeText(req.body.note, 2000);
    const problem = decideProblem(review, actor.id, decision, note);
    if (problem) return fail(res, problem);

    // Claimed first, so two clicks (or two windows) cannot decide the same round twice.
    const claimed = await db.query(
      `UPDATE task_reviews SET status = $1, decision_note = $2, decided_at = NOW() WHERE id = $3 AND status = 'pending' AND reviewer_id = $4 RETURNING id`,
      [DECISIONS[decision].status, note || null, review.id, actor.id]
    );
    if (!claimed.rows.length) return res.status(409).json({ error: 'This review was already decided or withdrawn' });

    let rolledTo = null;
    let todo;
    try {
      todo = await todoAsSeenBy(review.todo_id, [review.submitted_by, review.task_owner_id, actor.id]);
      if (!todo) todo = (await db.query('SELECT * FROM todos WHERE id = $1', [review.todo_id])).rows[0];
      if (decision === 'approve') {
        // The normal completion of the app: Done, sub-tasks, repeats, dependents.
        rolledTo = await finishTodo(todo, actor, { doneBy: review.submitted_by || ownerIdOf(todo) });
        if (!rolledTo) await db.query('UPDATE todos SET approved_by = $1, approved_at = NOW() WHERE id = $2', [actor.id, todo.id]);
        await logEvent({ todoId: todo.id, userId: actor.id, subjectId: todo.assignee_id, kind: 'approved', note: note || null });
      } else {
        // Back to the owner: "In progress" to correct it, or "Not started" when the work was rejected.
        const target = decision === 'changes' ? 'in_progress' : 'todo';
        await db.query('UPDATE todos SET submitted_by = NULL, submitted_at = NULL WHERE id = $1', [todo.id]);
        await setStatus(todo.id, target);
        await logEvent({
          todoId: todo.id, userId: actor.id, subjectId: todo.assignee_id, kind: 'changes_requested', from: 'in_review', to: target,
          note: decision === 'reject' ? `Rejected: ${note}` : note,
        });
      }
    } catch (err) {
      // The task could not be updated: the review is still waiting.
      await db.query(`UPDATE task_reviews SET status = 'pending', decision_note = NULL, decided_at = NULL WHERE id = $1`, [review.id]);
      throw err;
    }

    const title = decision === 'approve' ? `${actor.name} approved your task`
      : decision === 'changes' ? `${actor.name} asked for changes` : `${actor.name} rejected your task`;
    await notify([review.submitted_by, todo.assignee_id, ...(decision === 'approve' ? [todo.created_by] : [])], {
      type: decision === 'approve' ? 'task_approved' : 'task_rejected',
      title,
      body: note ? `${review.task_title}: ${note}` : review.task_title,
      data: { todoId: todo.id, reviewId: review.id, screen: 'Review' },
    }, { exclude: [actor.id] });

    await announce(todo.id);
    res.json({ review: await reviewById(review.id), rolled_to: rolledTo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
