// The rules of Review & Approval (routes/reviews.js, table task_reviews). Pure functions, so they are tested
// without a database.

const DECISIONS = {
  approve: { status: 'approved', needsNote: false },
  changes: { status: 'changes_requested', needsNote: true, missing: 'Say what needs to be corrected' },
  reject: { status: 'rejected', needsNote: true, missing: 'A reason is needed to reject' },
};

/** The task owner: the person it is assigned to, or its creator when nobody is. */
const ownerIdOf = (todo) => todo.assignee_id || todo.created_by;
const isOwner = (todo, userId) => ownerIdOf(todo) === userId;

/** Why `userId` may not send this task for review, or null when they may. `todo` is the row as they see it. */
function submitProblem(todo, userId, hasPending) {
  if (!isOwner(todo, userId)) return { status: 403, error: 'Only the person the task belongs to can send it for review' };
  if (todo.permissions && !todo.permissions.can_change_status) return { status: 403, error: 'You cannot update this task' };
  if (todo.review_state && todo.review_state !== 'accepted') return { status: 400, error: 'This task is still waiting to be accepted' };
  if (todo.is_done) return { status: 400, error: 'This task is already done. Reopen it first.' };
  if (hasPending) return { status: 409, error: 'This task is already with a reviewer' };
  return null;
}

/** Why `userId` may not decide this review, or null when they may. Only the assigned reviewer ever can. */
function decideProblem(review, userId, decision, note) {
  const rule = DECISIONS[decision];
  if (!rule) return { status: 400, error: 'Unknown decision' };
  if (review.reviewer_id !== userId) return { status: 403, error: `Only the assigned reviewer (${review.reviewer_name}) can decide this` };
  if (review.submitted_by === userId) return { status: 403, error: 'You cannot review your own work' };
  if (review.status !== 'pending') return { status: 409, error: 'This review was already decided or withdrawn' };
  if (rule.needsNote && !note) return { status: 400, error: rule.missing };
  return null;
}

/**
 * The lists of the Review page, from the review rows a person takes part in (as sender or reviewer).
 * `is_latest` marks the newest round of its task: an older "changes requested" disappears from that list once
 * the task was sent again, and stays in the history.
 */
function groupReviews(rows, userId) {
  const items = rows
    .map((r) => ({
      ...r,
      can_decide: r.status === 'pending' && r.reviewer_id === userId,
      can_resubmit: r.status === 'changes_requested' && !!r.is_latest && !r.task_done && r.task_owner_id === userId,
    }))
    .sort((a, b) => b.id - a.id);
  const latest = (status) => items.filter((r) => r.is_latest && r.status === status);
  const lists = {
    pending: items.filter((r) => r.status === 'pending' && r.reviewer_id === userId),
    submitted: items.filter((r) => r.status === 'pending' && r.submitted_by === userId),
    approved: latest('approved'),
    changes_requested: latest('changes_requested'),
    rejected: latest('rejected'),
    history: items,
  };
  return { ...lists, counts: Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])) };
}

module.exports = { DECISIONS, ownerIdOf, isOwner, submitProblem, decideProblem, groupReviews };
