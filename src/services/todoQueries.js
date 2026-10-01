const db = require('../db');
const { APP_TIMEZONE } = require('../utils/recurrence');

const TZ = String(APP_TIMEZONE).replace(/'/g, "''");

/**
 * One to-do as seen by one person (the join on todo_members decides whose list placement,
 * section and order come back). Used by the to-do routes and the Team Monitor.
 */
const TODO_SELECT = `
  SELECT t.id, t.title, t.notes, t.due_date, to_char(t.due_time, 'HH24:MI') AS due_time,
         t.priority, t.recurrence, t.is_done, t.done_at, t.done_by, t.created_by, t.created_at, t.updated_at,
         t.parent_id, t.labels, t.deadline_date, t.duration_minutes, t.reminder_offsets,
         t.status, t.assignee_id, t.assigned_at, t.started_at, t.status_since, t.status_seconds,
         ((t.due_date + COALESCE(t.due_time, TIME '23:59')) AT TIME ZONE '${TZ}') AS due_at,
         ((t.deadline_date + TIME '23:59') AT TIME ZONE '${TZ}') AS deadline_at,
         tm.list_id, tm.section_id, tm.sort_order,
         cu.name AS created_by_name, cu.username AS created_by_username,
         du.name AS done_by_name,
         au.name AS assignee_name, au.username AS assignee_username,
         (SELECT COUNT(*)::int FROM todo_blockers b WHERE b.todo_id = t.id AND b.resolved_at IS NULL) AS open_blocker_count,
         (SELECT COUNT(*)::int FROM todos c WHERE c.parent_id = t.id) AS subtask_count,
         (SELECT COUNT(*)::int FROM todos c WHERE c.parent_id = t.id AND c.is_done) AS subtask_done_count,
         (SELECT COUNT(*)::int FROM todo_comments tc WHERE tc.todo_id = t.id) AS comment_count,
         (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username,
                                            'profile_picture', u.profile_picture) ORDER BY m2.added_at)
          FROM todo_members m2 JOIN users u ON u.id = m2.user_id
          WHERE m2.todo_id = t.id) AS members
  FROM todo_members tm
  JOIN todos t ON t.id = tm.todo_id
  JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users du ON du.id = t.done_by
  LEFT JOIN users au ON au.id = t.assignee_id`;

async function getTodoFor(todoId, userId) {
  const result = await db.query(`${TODO_SELECT} WHERE tm.user_id = $1 AND t.id = $2`, [userId, todoId]);
  return result.rows[0] || null;
}

async function memberIds(todoId) {
  const result = await db.query('SELECT user_id FROM todo_members WHERE todo_id = $1', [todoId]);
  return result.rows.map((r) => r.user_id);
}

module.exports = { TODO_SELECT, getTodoFor, memberIds };
