const {
  levelWithDesignation,
  actorLevelIn,
  isLeader,
  managesBusiness,
  loadActor,
  OUTSIDER_LEVEL,
} = require('../utils/org');

/**
 * Who may see and do what with a to-do.
 *
 * Personal to-dos (no business) belong to the people on them (todo_members): they can all edit and
 * tick them, the creator deletes them for everyone.
 *
 * Business to-dos follow the chain of command (lower level number = more senior):
 *   - everyone in the business sees them, leadership sees all of them
 *   - the creator, or anyone senior to the creator, edits and deletes
 *   - the assignee (or anyone, when unassigned) does the work; seniors may too
 *   - a senior person reviews finished work and proposals, and may warn the assignee
 * Nobody ever acts on someone more senior than themselves.
 */

function levelOf(row, prefix) {
  if (!row[`_${prefix}_role`] && !row[`_${prefix}_org_level`]) return OUTSIDER_LEVEL;
  return levelWithDesignation(
    { role: row[`_${prefix}_role`], org_level: row[`_${prefix}_org_level`] },
    row[`_${prefix}_designation`]
  );
}

/**
 * SQL parameters $1..$4 that every visibility-aware to-do query starts with. `seeAll` is for looking one
 * to-do up (or the audit list): holders of view_all_todos then see any to-do, read-only. Lists that feed
 * a person's own views never pass it.
 */
async function viewerParams(userId, actor = null, seeAll = false) {
  const a = actor || await loadActor(userId);
  if (!a) return [userId, false, [], []];
  const memberOf = [...a.memberships.keys()];
  // A 0 in the business list is the "sees every to-do" switch (see VISIBLE in todoQueries.js).
  const sees = seeAll && typeof a.can === 'function' && a.can('view_all_todos') ? [0] : [];
  return [a.id, isLeader(a), [...sees, ...memberOf], memberOf.filter((id) => managesBusiness(a, id))];
}

/** Parameters that limit a query to what is literally on someone's own list (no business visibility). */
function listOnlyParams(userId) {
  return [userId, false, [], []];
}

function personalPermissions(row) {
  const isMember = !!row.is_member;
  const isCreator = row.created_by === row._actor_id;
  return {
    can_edit: isMember,
    can_delete: isMember && isCreator,
    can_leave: isMember && !isCreator,
    can_request_delete: false,
    can_change_status: isMember,
    can_hold: isMember,
    can_assign: isMember,
    can_approve: false,
    can_review: false,
    can_warn: false,
    can_comment: true,
    can_add_subtask: isMember,
  };
}

function businessPermissions(row, actor) {
  const bid = row.business_id;
  const myLevel = actorLevelIn(actor, bid);
  const creatorLevel = levelOf(row, 'creator');
  const assigneeLevel = row.assignee_id ? levelOf(row, 'assignee') : null;
  const submitterLevel = row.submitted_by ? levelOf(row, 'submitter') : null;
  const isCreator = row.created_by === actor.id;
  const isAssignee = row.assignee_id === actor.id;
  const inBusiness = actor.memberships.has(Number(bid));
  const manages = managesBusiness(actor, bid);
  const outranksCreator = myLevel < creatorLevel;
  const rejected = row.review_state === 'rejected';

  const canEdit = !rejected && (isCreator || outranksCreator);
  const canWork = !rejected && (
    isAssignee || isCreator || outranksCreator
    || (!row.assignee_id && inBusiness)
    || (assigneeLevel !== null && myLevel < assigneeLevel)
  );
  const reviewTargetLevel = submitterLevel ?? assigneeLevel ?? OUTSIDER_LEVEL;
  const canApprove = row.status === 'in_review'
    && row.submitted_by !== actor.id
    && (isCreator || myLevel < reviewTargetLevel);
  const canWarn = row.review_state === 'accepted' && !row.is_done && row.status !== 'on_hold' && (
    assigneeLevel !== null
      ? myLevel < assigneeLevel && (isCreator || myLevel <= 5 || isLeader(actor))
      : manages
  );
  const canDelete = isCreator || outranksCreator;

  return {
    can_edit: canEdit,
    can_delete: canDelete,
    can_leave: false,
    can_request_delete: !canDelete && (isAssignee || inBusiness) && !row.pending_delete_request_id,
    can_change_status: canWork,
    can_hold: canEdit || (manages && !rejected),
    can_assign: canEdit || (manages && !rejected),
    can_approve: canApprove,
    can_review: row.review_state !== 'accepted' && !isCreator && manages && outranksCreator,
    can_warn: canWarn,
    can_comment: true,
    can_add_subtask: canWork,
  };
}

/**
 * Attach permission flags and drop the internal columns (_creator_*, ...) used to compute them.
 * `row` comes from TODO_SELECT.
 */
function decorateTodo(row, actor) {
  const permissions = row.business_id == null
    ? personalPermissions({ ...row, _actor_id: actor.id })
    : businessPermissions(row, actor);
  const todo = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('_')) todo[key] = value;
  }
  todo.permissions = permissions;
  todo.my_level = row.business_id == null ? null : actorLevelIn(actor, row.business_id);
  return todo;
}

module.exports = { decorateTodo, viewerParams, listOnlyParams };
