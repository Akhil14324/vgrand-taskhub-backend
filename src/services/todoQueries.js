const db = require('../db');
const { APP_TIMEZONE } = require('../utils/recurrence');
const { loadActor } = require('../utils/org');
const { decorateTodo, viewerParams, listOnlyParams } = require('./todoAccess');

const TZ = String(APP_TIMEZONE).replace(/'/g, "''");

/**
 * One to-do as seen by one person. $1..$4 are always the viewer (see viewerParams): $1 decides whose
 * list placement, section and order come back; the rest feed VISIBLE. Extra query parameters start at $5.
 * Used by the to-do routes, the Team Monitor and approvals.
 */
const TODO_SELECT = `
  SELECT t.id, t.title, t.notes, t.due_date, to_char(t.due_time, 'HH24:MI') AS due_time,
         t.priority, t.recurrence, t.is_done, t.done_at, t.done_by, t.created_by, t.created_at, t.updated_at,
         t.parent_id, t.labels, t.deadline_date, t.duration_minutes, t.reminder_offsets,
         t.status, t.assignee_id, t.assigned_at, t.started_at, t.status_since, t.status_seconds,
         t.business_id, t.source_business_id, t.requires_approval, t.approved_by, t.approved_at,
         t.submitted_by, t.submitted_at, t.review_state, t.reviewed_by, t.reviewed_at, t.review_note, t.is_warned,
         ((t.due_date + COALESCE(t.due_time, TIME '23:59')) AT TIME ZONE '${TZ}') AS due_at,
         ((t.deadline_date + TIME '23:59') AT TIME ZONE '${TZ}') AS deadline_at,
         (tm.user_id IS NOT NULL) AS is_member,
         tm.list_id, tm.section_id, tm.sort_order, bo.position AS board_pos,
         cu.name AS created_by_name, cu.username AS created_by_username,
         du.name AS done_by_name,
         au.name AS assignee_name, au.username AS assignee_username, au.profile_picture AS assignee_picture,
         su.name AS submitted_by_name,
         apu.name AS approved_by_name,
         rvu.name AS reviewed_by_name,
         b.name AS business_name, b.type AS business_type, b.color AS business_color,
         sb.name AS source_business_name,
         w.message AS warning_message, w.created_at AS warning_created_at,
         (SELECT apr.id FROM approvals apr
           WHERE apr.todo_id = t.id AND apr.kind IN ('todo_deletion', 'task_deletion') AND apr.status = 'pending'
           LIMIT 1) AS pending_delete_request_id,
         (SELECT COUNT(*)::int FROM todo_blockers bl WHERE bl.todo_id = t.id AND bl.resolved_at IS NULL) AS open_blocker_count,
         (SELECT COUNT(*)::int FROM todos c WHERE c.parent_id = t.id) AS subtask_count,
         (SELECT COUNT(*)::int FROM todos c WHERE c.parent_id = t.id AND c.is_done) AS subtask_done_count,
         (SELECT COUNT(*)::int FROM todo_comments tc WHERE tc.todo_id = t.id) AS comment_count,
         (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username,
                                            'profile_picture', u.profile_picture) ORDER BY m2.added_at)
          FROM todo_members m2 JOIN users u ON u.id = m2.user_id
          WHERE m2.todo_id = t.id) AS members,
         cu.role AS _creator_role, cu.org_level AS _creator_org_level, cub.designation AS _creator_designation,
         au.role AS _assignee_role, au.org_level AS _assignee_org_level, aub.designation AS _assignee_designation,
         su.role AS _submitter_role, su.org_level AS _submitter_org_level, sub.designation AS _submitter_designation
  FROM todos t
  LEFT JOIN todo_members tm ON tm.todo_id = t.id AND tm.user_id = $1
  LEFT JOIN todo_board_order bo ON bo.todo_id = t.id AND bo.user_id = $1
  JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users du ON du.id = t.done_by
  LEFT JOIN users au ON au.id = t.assignee_id
  LEFT JOIN users su ON su.id = t.submitted_by
  LEFT JOIN users apu ON apu.id = t.approved_by
  LEFT JOIN users rvu ON rvu.id = t.reviewed_by
  LEFT JOIN businesses b ON b.id = t.business_id
  LEFT JOIN businesses sb ON sb.id = t.source_business_id
  LEFT JOIN user_businesses cub ON cub.user_id = t.created_by AND cub.business_id = t.business_id
  LEFT JOIN user_businesses aub ON aub.user_id = t.assignee_id AND aub.business_id = t.business_id
  LEFT JOIN user_businesses sub ON sub.user_id = t.submitted_by AND sub.business_id = t.business_id
  LEFT JOIN LATERAL (
    SELECT message, created_at FROM warnings WHERE todo_id = t.id ORDER BY created_at DESC LIMIT 1
  ) w ON true`;

/**
 * What the viewer ($1..$4) may see: what is on their own list, plus business to-dos of businesses
 * they belong to (leadership: every business). Proposals that were rejected stay visible only to the
 * people who manage that business, and to whoever raised them (they are on the to-do).
 */
const VISIBLE = `(tm.user_id IS NOT NULL OR (t.business_id IS NOT NULL
    AND ($2::boolean OR t.business_id = ANY($3::int[]))
    AND (t.review_state <> 'rejected' OR $2::boolean OR t.business_id = ANY($4::int[]))))`;

/**
 * Decorated rows for a viewer. `where` may use $5 and up; `tail` is appended (ORDER BY / LIMIT).
 * Pass `listOnly: true` to see only what is on the viewer's own list.
 */
async function listTodos(userId, { where = 'TRUE', params = [], tail = '', actor = null, listOnly = false } = {}) {
  const a = actor || await loadActor(userId);
  const viewer = listOnly ? listOnlyParams(userId) : await viewerParams(userId, a);
  const result = await db.query(
    `${TODO_SELECT} WHERE ${VISIBLE} AND (${where}) ${tail}`,
    [...viewer, ...params]
  );
  return result.rows.map((row) => decorateTodo(row, a));
}

/** One to-do as seen (and permitted) for a person, or null when they cannot see it. */
async function getTodoFor(todoId, userId, actor = null) {
  const id = parseInt(todoId, 10);
  if (!id) return null;
  const rows = await listTodos(userId, { where: 't.id = $5', params: [id], actor });
  return rows[0] || null;
}

/** People on the to-do itself (creator, assignee, @mentioned, shared with). */
async function memberIds(todoId) {
  const result = await db.query('SELECT user_id FROM todo_members WHERE todo_id = $1', [todoId]);
  return result.rows.map((r) => r.user_id);
}

/**
 * Everyone who should hear about a change: the people on it, and for business to-dos also everyone in
 * the business and leadership (they see it in their lists).
 */
async function audienceIds(todoId) {
  const result = await db.query(
    `SELECT user_id FROM todo_members WHERE todo_id = $1
     UNION
     SELECT ub.user_id FROM todos t JOIN user_businesses ub ON ub.business_id = t.business_id WHERE t.id = $1
     UNION
     SELECT u.id FROM users u
       WHERE u.status != 'inactive' AND (u.org_level IS NOT NULL OR u.role IN ('admin', 'super_admin'))
         AND EXISTS (SELECT 1 FROM todos t WHERE t.id = $1 AND t.business_id IS NOT NULL)`,
    [todoId]
  );
  return result.rows.map((r) => r.user_id);
}

/** Ids of everything below a to-do (sub-tasks, their sub-tasks, ...), not including itself. */
async function descendantIds(todoId) {
  const result = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM todos WHERE parent_id = $1
       UNION ALL
       SELECT c.id FROM todos c JOIN tree ON c.parent_id = tree.id
     ) SELECT id FROM tree`,
    [todoId]
  );
  return result.rows.map((r) => r.id);
}

/** How many levels deep a to-do sits (a top-level to-do is depth 0). */
async function depthOf(todoId) {
  const result = await db.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, 0 AS depth FROM todos WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id, up.depth + 1 FROM todos p JOIN up ON p.id = up.parent_id
     ) SELECT MAX(depth)::int AS depth FROM up`,
    [todoId]
  );
  return result.rows[0]?.depth ?? 0;
}

/** Height of the sub-tree below a to-do (a to-do without sub-tasks has height 0). */
async function heightOf(todoId) {
  const result = await db.query(
    `WITH RECURSIVE down AS (
       SELECT id, 0 AS depth FROM todos WHERE id = $1
       UNION ALL
       SELECT c.id, down.depth + 1 FROM todos c JOIN down ON c.parent_id = down.id
     ) SELECT MAX(depth)::int AS depth FROM down`,
    [todoId]
  );
  return result.rows[0]?.depth ?? 0;
}

module.exports = {
  TODO_SELECT,
  VISIBLE,
  listTodos,
  getTodoFor,
  memberIds,
  audienceIds,
  descendantIds,
  depthOf,
  heightOf,
};
