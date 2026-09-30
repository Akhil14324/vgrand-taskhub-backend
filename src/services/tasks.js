const db = require('../db');
const { getIO } = require('../utils/notify');
const {
  levelWithDesignation,
  actorLevelIn,
  isLeader,
  managesBusiness,
  OUTSIDER_LEVEL,
} = require('../utils/org');

const OPEN_STATUSES = ['pending', 'in_progress', 'in_review', 'on_hold'];

const TASK_SELECT = `
  SELECT t.*,
    u.name AS created_by_name, u.username AS created_by_username,
    c.name AS completed_by_name,
    a.name AS assigned_user_name, a.username AS assigned_user_username,
    a.profile_picture AS assigned_user_picture,
    ap.name AS approved_by_name,
    b.name AS business_name, b.type AS business_type, b.color AS business_color,
    sb.name AS source_business_name,
    w.message AS warning_message, w.created_at AS warning_created_at,
    u.role AS _creator_role, u.org_level AS _creator_org_level, cub.designation AS _creator_designation,
    a.role AS _assignee_role, a.org_level AS _assignee_org_level, aub.designation AS _assignee_designation,
    c.role AS _completer_role, c.org_level AS _completer_org_level, ccb.designation AS _completer_designation,
    (SELECT COUNT(*) FROM task_activity ta WHERE ta.task_id = t.id AND ta.kind = 'comment')::int AS comment_count,
    (SELECT apr.id FROM approvals apr
      WHERE apr.task_id = t.id AND apr.kind = 'task_deletion' AND apr.status = 'pending'
      LIMIT 1) AS pending_delete_request_id
  FROM tasks t
  JOIN users u ON t.created_by = u.id
  LEFT JOIN users c ON t.completed_by = c.id
  LEFT JOIN users a ON t.assigned_user_id = a.id
  LEFT JOIN users ap ON t.approved_by = ap.id
  JOIN businesses b ON t.business_id = b.id
  LEFT JOIN businesses sb ON t.source_business_id = sb.id
  LEFT JOIN user_businesses cub ON cub.user_id = t.created_by AND cub.business_id = t.business_id
  LEFT JOIN user_businesses aub ON aub.user_id = t.assigned_user_id AND aub.business_id = t.business_id
  LEFT JOIN user_businesses ccb ON ccb.user_id = t.completed_by AND ccb.business_id = t.business_id
  LEFT JOIN LATERAL (
    SELECT message, created_at FROM warnings
    WHERE task_id = t.id
    ORDER BY created_at DESC LIMIT 1
  ) w ON true`;

function levelOf(row, prefix) {
  if (!row[`_${prefix}_role`] && !row[`_${prefix}_org_level`]) return OUTSIDER_LEVEL;
  return levelWithDesignation(
    { role: row[`_${prefix}_role`], org_level: row[`_${prefix}_org_level`] },
    row[`_${prefix}_designation`]
  );
}

/** Can the actor see this task at all? */
function canView(row, actor) {
  if (!actor) return false;
  if (isLeader(actor)) return true;
  if (row.created_by === actor.id || row.assigned_user_id === actor.id) return true;
  if (managesBusiness(actor, row.business_id)) return true;
  return actor.memberships.has(Number(row.business_id)) && !row.assigned_user_id;
}

/**
 * Attach permission flags computed from the chain of command and strip the
 * internal columns used to compute them.
 */
function decorateTask(row, actor) {
  const myLevel = actorLevelIn(actor, row.business_id);
  const creatorLevel = levelOf(row, 'creator');
  const assigneeLevel = row.assigned_user_id ? levelOf(row, 'assignee') : null;
  const completerLevel = row.completed_by ? levelOf(row, 'completer') : null;
  const isCreator = row.created_by === actor.id;
  const isAssignee = row.assigned_user_id === actor.id;
  const isMember = actor.memberships.has(Number(row.business_id));
  const outranksCreator = myLevel < creatorLevel;

  const canEdit = isCreator || outranksCreator;
  const canWork = isAssignee || canEdit
    || (!row.assigned_user_id && isMember)
    || (assigneeLevel !== null && myLevel < assigneeLevel);
  const reviewTargetLevel = completerLevel ?? assigneeLevel ?? OUTSIDER_LEVEL;
  const canApprove = row.status === 'in_review'
    && row.completed_by !== actor.id
    && (isCreator || myLevel < reviewTargetLevel);
  const canWarn = row.status !== 'completed' && row.status !== 'on_hold' && (
    assigneeLevel !== null ? myLevel < assigneeLevel && (isCreator || myLevel <= 5 || isLeader(actor)) : managesBusiness(actor, row.business_id)
  );

  const task = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('_')) task[key] = value;
  }
  task.permissions = {
    can_edit: canEdit,
    can_delete: canEdit,
    can_request_delete: !canEdit && (isAssignee || isMember) && !row.pending_delete_request_id,
    can_change_status: canWork,
    can_hold: canEdit || managesBusiness(actor, row.business_id),
    can_approve: canApprove,
    can_warn: canWarn,
    can_comment: true,
  };
  task.my_level = myLevel;
  return task;
}

async function fetchTaskRow(taskId) {
  const result = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
  return result.rows[0] || null;
}

/** Load one task for an actor: returns { task } or { error, status }. */
async function getTaskForActor(taskId, actor) {
  const row = await fetchTaskRow(taskId);
  if (!row) return { status: 404, error: 'Task not found' };
  if (!canView(row, actor)) return { status: 403, error: 'You do not have access to this task' };
  return { task: decorateTask(row, actor), row };
}

async function recordActivity(taskId, userId, kind, body = null, meta = null, client = db) {
  const result = await client.query(
    `INSERT INTO task_activity (task_id, user_id, kind, body, meta)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [taskId, userId, kind, body, meta]
  );
  return result.rows[0];
}

/** Tell every connected client that a task changed so open lists can refresh. */
function broadcastTaskChange(taskId, businessId, action = 'updated') {
  const io = getIO();
  if (io) io.emit('task:changed', { taskId: Number(taskId), businessId: Number(businessId), action });
}

/** Remove warnings on a task and reset users who have no other warnings. */
async function clearWarnings(taskId, client = db) {
  const warned = await client.query('SELECT DISTINCT user_id FROM warnings WHERE task_id = $1', [taskId]);
  if (warned.rows.length === 0) return;
  await client.query('DELETE FROM warnings WHERE task_id = $1', [taskId]);
  await client.query('UPDATE tasks SET is_warned = false WHERE id = $1', [taskId]);
  for (const w of warned.rows) {
    const remaining = await client.query('SELECT 1 FROM warnings WHERE user_id = $1 LIMIT 1', [w.user_id]);
    if (remaining.rows.length === 0) {
      await client.query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'warned'", [w.user_id]);
    }
  }
}

/**
 * Members of a business. maxLevel keeps only people at that level or more senior;
 * belowLevel keeps only people junior to that level.
 */
async function businessMemberIds(businessId, { maxLevel = null, belowLevel = null, excludeId = null } = {}) {
  const result = await db.query(
    `SELECT u.id, u.role, u.org_level, ub.designation
     FROM user_businesses ub JOIN users u ON u.id = ub.user_id
     WHERE ub.business_id = $1 AND u.status != 'inactive'`,
    [businessId]
  );
  return result.rows
    .filter((r) => r.id !== excludeId)
    .filter((r) => maxLevel === null || levelWithDesignation(r, r.designation) <= maxLevel)
    .filter((r) => belowLevel === null || levelWithDesignation(r, r.designation) > belowLevel)
    .map((r) => r.id);
}

module.exports = {
  OPEN_STATUSES,
  TASK_SELECT,
  canView,
  decorateTask,
  fetchTaskRow,
  getTaskForActor,
  recordActivity,
  broadcastTaskChange,
  clearWarnings,
  businessMemberIds,
};
