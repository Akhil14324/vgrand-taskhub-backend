const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify } = require('../utils/notify');
const { loadActor, actorLevelIn } = require('../utils/org');
const { TASK_SELECT, decorateTask, recordActivity, broadcastTaskChange, clearWarnings } = require('../services/tasks');

const router = express.Router();

const APPROVAL_SELECT = `
  SELECT ap.*, COALESCE(t.title, ap.subject) AS task_title, t.created_by AS task_created_by, t.assigned_user_id AS task_assigned_user_id,
         b.name AS business_name, ru.name AS requested_by_name, ru.username AS requested_by_username,
         du.name AS decided_by_name
  FROM approvals ap
  LEFT JOIN tasks t ON t.id = ap.task_id
  LEFT JOIN businesses b ON b.id = ap.business_id
  JOIN users ru ON ru.id = ap.requested_by
  LEFT JOIN users du ON du.id = ap.decided_by`;

function canDecide(approval, actor) {
  if (approval.requested_by === actor.id) return false;
  if (approval.task_created_by === actor.id) return true;
  return actorLevelIn(actor, approval.business_id) < approval.requester_level;
}

// GET /api/approvals — what is waiting on me, and my own open requests
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const [pending, reviews, mine] = await Promise.all([
      db.query(`${APPROVAL_SELECT} WHERE ap.status = 'pending' ORDER BY ap.created_at DESC`),
      db.query(`${TASK_SELECT} WHERE t.status = 'in_review' ORDER BY t.completed_at DESC`),
      db.query(
        `${APPROVAL_SELECT} WHERE ap.requested_by = $1 AND ap.created_at > NOW() - INTERVAL '30 days'
         ORDER BY ap.created_at DESC LIMIT 30`,
        [actor.id]
      ),
    ]);

    const requests = pending.rows.filter((a) => canDecide(a, actor));
    const reviewTasks = reviews.rows
      .map((row) => decorateTask(row, actor))
      .filter((task) => task.permissions.can_approve);

    res.json({
      requests,
      reviews: reviewTasks,
      mine: mine.rows,
      count: requests.length + reviewTasks.length,
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

    if (approval.kind === 'task_deletion' && approval.task_id) {
      if (decision === 'approve') {
        await clearWarnings(approval.task_id);
        await db.query('DELETE FROM tasks WHERE id = $1', [approval.task_id]);
        broadcastTaskChange(approval.task_id, approval.business_id, 'deleted');
      } else {
        await recordActivity(approval.task_id, actor.id, 'delete_rejected', note);
        broadcastTaskChange(approval.task_id, approval.business_id);
      }
    }

    await notify([approval.requested_by], {
      type: decision === 'approve' ? 'approval_approved' : 'approval_rejected',
      title: decision === 'approve'
        ? `✅ ${actor.name} approved your request`
        : `❌ ${actor.name} declined your request`,
      body: `${approval.kind === 'task_deletion' ? 'Delete' : 'Request'}: ${approval.task_title || 'task'}${note ? ` — "${note}"` : ''}`,
      data: decision === 'approve' && approval.kind === 'task_deletion' ? {} : { taskId: approval.task_id },
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
       WHERE id = $1 AND requested_by = $2 AND status = 'pending' RETURNING task_id, business_id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Request not found' });
    const { task_id: taskId, business_id: businessId } = result.rows[0];
    if (taskId) broadcastTaskChange(taskId, businessId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
