const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { loadActor, actorLevelIn } = require('../utils/org');
const { listTodos, audienceIds } = require('../services/todoQueries');
const { clearWarnings } = require('../services/todoGovernance');
const { logEvent } = require('../services/todoTimeline');

const router = express.Router();

const DELETE_KINDS = ['todo_deletion', 'task_deletion'];

const APPROVAL_SELECT = `
  SELECT ap.*, COALESCE(t.title, ap.subject) AS todo_title, t.created_by AS todo_created_by,
         t.assignee_id AS todo_assignee_id,
         b.name AS business_name, ru.name AS requested_by_name, ru.username AS requested_by_username,
         du.name AS decided_by_name
  FROM approvals ap
  LEFT JOIN todos t ON t.id = ap.todo_id
  LEFT JOIN businesses b ON b.id = ap.business_id
  JOIN users ru ON ru.id = ap.requested_by
  LEFT JOIN users du ON du.id = ap.decided_by`;

function canDecide(approval, actor) {
  if (approval.requested_by === actor.id) return false;
  if (approval.todo_created_by === actor.id) return true;
  return actorLevelIn(actor, approval.business_id) < approval.requester_level;
}

// GET /api/approvals — what is waiting on me, and my own open requests
//   requests: deletion requests I can decide · reviews: finished work I can approve
//   proposals: business to-dos I can accept or decline · mine: my own requests
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const [pending, reviews, proposals, mine] = await Promise.all([
      db.query(`${APPROVAL_SELECT} WHERE ap.status = 'pending' ORDER BY ap.created_at DESC`),
      listTodos(actor.id, { actor, where: `t.status = 'in_review'`, tail: 'ORDER BY t.submitted_at DESC' }),
      listTodos(actor.id, { actor, where: `t.review_state = 'proposed' AND t.parent_id IS NULL`, tail: 'ORDER BY t.created_at DESC' }),
      db.query(
        `${APPROVAL_SELECT} WHERE ap.requested_by = $1 AND ap.created_at > NOW() - INTERVAL '30 days'
         ORDER BY ap.created_at DESC LIMIT 30`,
        [actor.id]
      ),
    ]);

    const requests = pending.rows.filter((a) => canDecide(a, actor));
    const reviewTodos = reviews.filter((todo) => todo.permissions.can_approve);
    const proposalTodos = proposals.filter((todo) => todo.permissions.can_review);

    res.json({
      requests,
      reviews: reviewTodos,
      proposals: proposalTodos,
      mine: mine.rows,
      count: requests.length + reviewTodos.length + proposalTodos.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/approvals/:id/decide — { decision: 'approve' | 'reject', note? }
router.post('/:id/decide', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const decision = req.body.decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
    const note = sanitizeText(req.body.note, 1000) || null;

    const result = await db.query(`${APPROVAL_SELECT} WHERE ap.id = $1`, [req.params.id]);
    const approval = result.rows[0];
    if (!approval) return res.status(404).json({ error: 'Request not found' });
    if (approval.status !== 'pending') return res.status(409).json({ error: 'This request was already handled' });
    if (!canDecide(approval, actor)) return res.status(403).json({ error: 'Only someone senior to the requester can decide this' });

    await db.query(
      `UPDATE approvals SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $4`,
      [decision === 'approve' ? 'approved' : 'rejected', actor.id, note, approval.id]
    );

    const isDelete = DELETE_KINDS.includes(approval.kind);
    if (isDelete && approval.todo_id) {
      const audience = await audienceIds(approval.todo_id);
      if (decision === 'approve') {
        await logEvent({
          todoId: null, userId: actor.id, subjectId: approval.todo_assignee_id, kind: 'deleted',
          meta: { title: approval.todo_title, business_id: approval.business_id, requested_by: approval.requested_by },
        });
        await clearWarnings(approval.todo_id);
        await db.query('DELETE FROM todos WHERE id = $1', [approval.todo_id]);
        emitToUsers(audience, 'todo:changed', { todoId: approval.todo_id, action: 'deleted' });
      } else {
        await logEvent({ todoId: approval.todo_id, userId: actor.id, subjectId: approval.todo_assignee_id, kind: 'delete_rejected', note });
        emitToUsers(audience, 'todo:changed', { todoId: approval.todo_id, action: 'updated' });
      }
    }

    await notify([approval.requested_by], {
      type: decision === 'approve' ? 'approval_approved' : 'approval_rejected',
      title: decision === 'approve'
        ? `${actor.name} approved your request`
        : `${actor.name} declined your request`,
      body: `${isDelete ? 'Delete' : 'Request'}: ${approval.todo_title || 'task'}${note ? ` — "${note}"` : ''}`,
      data: decision === 'approve' && isDelete ? {} : { todoId: approval.todo_id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/approvals/:id — requester withdraws their request
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE approvals SET status = 'cancelled', decided_at = NOW()
       WHERE id = $1 AND requested_by = $2 AND status = 'pending' RETURNING todo_id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Request not found' });
    const todoId = result.rows[0].todo_id;
    if (todoId) emitToUsers(await audienceIds(todoId), 'todo:changed', { todoId, action: 'updated' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
