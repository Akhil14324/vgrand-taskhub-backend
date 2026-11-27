const test = require('node:test');
const assert = require('node:assert');
const { ownerIdOf, submitProblem, decideProblem, groupReviews } = require('./taskReviews');

const todo = (o = {}) => ({ id: 1, created_by: 1, assignee_id: 2, is_done: false, review_state: 'accepted', permissions: { can_change_status: true }, ...o });

test('the owner is the assignee, or the creator when nobody is assigned', () => {
  assert.strictEqual(ownerIdOf(todo()), 2);
  assert.strictEqual(ownerIdOf(todo({ assignee_id: null })), 1);
});

test('only the owner can send an open, accepted task, and only once at a time', () => {
  assert.strictEqual(submitProblem(todo(), 2, false), null);
  assert.strictEqual(submitProblem(todo({ assignee_id: null }), 1, false), null);
  assert.strictEqual(submitProblem(todo(), 1, false).status, 403, 'the creator is not the owner once it is assigned');
  assert.strictEqual(submitProblem(todo(), 3, false).status, 403);
  assert.strictEqual(submitProblem(todo({ permissions: { can_change_status: false } }), 2, false).status, 403);
  assert.match(submitProblem(todo({ is_done: true }), 2, false).error, /already done/);
  assert.strictEqual(submitProblem(todo({ review_state: 'proposed' }), 2, false).status, 400);
  assert.strictEqual(submitProblem(todo(), 2, true).status, 409);
});

const review = (o = {}) => ({ id: 1, reviewer_id: 5, reviewer_name: 'Rev', submitted_by: 2, status: 'pending', ...o });

test('only the assigned reviewer decides, once, and says why when sending it back', () => {
  assert.strictEqual(decideProblem(review(), 5, 'approve', ''), null);
  assert.strictEqual(decideProblem(review(), 5, 'changes', 'Fix the totals'), null);
  assert.strictEqual(decideProblem(review(), 5, 'reject', 'Wrong file'), null);
  for (const d of ['approve', 'changes', 'reject']) {
    assert.strictEqual(decideProblem(review(), 9, d, 'x').status, 403, `a stranger cannot ${d}`);
    assert.strictEqual(decideProblem(review(), 2, d, 'x').status, 403, `the sender cannot ${d}`);
  }
  assert.match(decideProblem(review(), 5, 'changes', '').error, /what needs to be corrected/);
  assert.match(decideProblem(review(), 5, 'reject', '').error, /reason is needed/);
  assert.strictEqual(decideProblem(review({ status: 'approved' }), 5, 'approve', '').status, 409);
  assert.strictEqual(decideProblem(review({ status: 'withdrawn' }), 5, 'reject', 'x').status, 409);
  assert.strictEqual(decideProblem(review({ reviewer_id: 2 }), 2, 'approve', '').status, 403, 'nobody reviews their own work');
  assert.strictEqual(decideProblem(review(), 5, 'delete', 'x').status, 400);
});

test('the lists show what each person should see, and history keeps every round', () => {
  const rows = [
    { id: 1, todo_id: 10, status: 'changes_requested', submitted_by: 2, reviewer_id: 5, is_latest: false, task_owner_id: 2, task_done: false },
    { id: 2, todo_id: 10, status: 'pending', submitted_by: 2, reviewer_id: 5, is_latest: true, task_owner_id: 2, task_done: false },
    { id: 3, todo_id: 11, status: 'changes_requested', submitted_by: 2, reviewer_id: 5, is_latest: true, task_owner_id: 2, task_done: false },
    { id: 4, todo_id: 12, status: 'approved', submitted_by: 2, reviewer_id: 5, is_latest: true, task_owner_id: 2, task_done: true },
    { id: 5, todo_id: 13, status: 'rejected', submitted_by: 2, reviewer_id: 5, is_latest: true, task_owner_id: 2, task_done: false },
    { id: 6, todo_id: 14, status: 'pending', submitted_by: 5, reviewer_id: 2, is_latest: true, task_owner_id: 5, task_done: false },
  ];
  const owner = groupReviews(rows, 2);
  assert.deepStrictEqual(owner.pending.map((r) => r.id), [6], 'pending = waiting for my decision');
  assert.deepStrictEqual(owner.submitted.map((r) => r.id), [2], 'submitted = mine, waiting');
  assert.deepStrictEqual(owner.changes_requested.map((r) => r.id), [3], 'a resubmitted task leaves the list');
  assert.deepStrictEqual(owner.approved.map((r) => r.id), [4]);
  assert.deepStrictEqual(owner.rejected.map((r) => r.id), [5]);
  assert.deepStrictEqual(owner.history.map((r) => r.id), [6, 5, 4, 3, 2, 1], 'newest first, nothing dropped');
  assert.ok(owner.changes_requested[0].can_resubmit);
  assert.ok(!owner.history.find((r) => r.id === 1).can_resubmit, 'an old round cannot be sent again');
  assert.ok(!owner.submitted[0].can_decide);

  const reviewer = groupReviews(rows, 5);
  assert.deepStrictEqual(reviewer.pending.map((r) => r.id), [2]);
  assert.ok(reviewer.pending[0].can_decide);
  assert.ok(!reviewer.changes_requested[0].can_resubmit, 'the reviewer cannot resubmit for the owner');
  assert.strictEqual(reviewer.counts.history, 6);
});
