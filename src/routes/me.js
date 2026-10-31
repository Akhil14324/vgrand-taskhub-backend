const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor } = require('../utils/org');
const { listTodos } = require('../services/todoQueries');
const { todayInAppZone } = require('../utils/recurrence');
const { draftsFor } = require('../services/drafts');

/**
 * /api/me: the person's own day (MONDAY_FEATURE_SPEC.md F-WM-00).
 *   GET /work   My work: overdue, due today, waiting on me (reviews, approvals, blockers on me), next 7 days,
 *               and the count of meeting drafts waiting in the Inbox. Every list is the same decorated to-do
 *               rows as the To-do screen.
 */
const router = express.Router();

router.get('/work', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const today = todayInAppZone();
    const mine = `(t.assignee_id = $5 OR (t.business_id IS NULL AND tm.user_id = $5 AND t.assignee_id IS NULL))`;
    const [open, review, blockedOnMe, drafts] = await Promise.all([
      listTodos(actor.id, {
        actor,
        where: `NOT t.is_done AND ${mine} AND (t.due_date <= $6::date + 7 OR t.deadline_date <= $6::date + 7)`,
        params: [actor.id, today],
        tail: 'ORDER BY LEAST(t.due_date, t.deadline_date) NULLS LAST, t.priority, t.created_at',
      }),
      // Finished work waiting for my approval, and steps waiting for my "go ahead".
      listTodos(actor.id, {
        actor,
        where: `NOT t.is_done AND (t.status = 'in_review' OR (t.step_state = 'awaiting_review' AND EXISTS (
                  SELECT 1 FROM todos p WHERE p.id = t.parent_id AND p.created_by = $5)))`,
        params: [actor.id],
        tail: 'ORDER BY t.updated_at DESC LIMIT 100',
      }),
      // Someone is stuck until I do my part.
      listTodos(actor.id, {
        actor,
        where: `NOT t.is_done AND EXISTS (SELECT 1 FROM todo_blockers bl WHERE bl.todo_id = t.id AND bl.resolved_at IS NULL AND bl.blocked_by_user_id = $5)`,
        params: [actor.id],
        tail: 'ORDER BY t.updated_at DESC LIMIT 100',
      }),
      draftsFor(actor.id),
    ]);

    const earliest = (t) => [t.due_date, t.deadline_date].filter(Boolean).sort()[0] || null;
    const overdue = open.filter((t) => earliest(t) && earliest(t) < today);
    const dueToday = open.filter((t) => earliest(t) === today);
    const upcoming = open.filter((t) => earliest(t) && earliest(t) > today);
    const waiting = [
      ...review.filter((t) => t.permissions.can_approve || (t.step_state === 'awaiting_review' && t.parent_created_by === actor.id)),
      ...blockedOnMe,
    ].filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i);

    res.json({
      today,
      overdue,
      due_today: dueToday,
      waiting_on_me: waiting,
      upcoming,
      drafts: { count: drafts.drafts.length, summary: drafts.summary },
      counts: { overdue: overdue.length, due_today: dueToday.length, waiting_on_me: waiting.length, upcoming: upcoming.length },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
