const db = require('../db');
const { levelWithDesignation, nextApprovers, actorLevelIn } = require('../utils/org');

/** Deepest a to-do may be nested (a top-level to-do is depth 0). Generous, but stops runaway trees. */
const MAX_DEPTH = 8;

/** Can this person be given work in the business? (a member, or leadership) */
async function isAssignable(userId, businessId) {
  const result = await db.query(
    `SELECT u.id FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $2
     WHERE u.id = $1 AND u.status != 'inactive'
       AND (ub.user_id IS NOT NULL OR u.org_level IS NOT NULL OR u.role IN ('admin', 'super_admin'))`,
    [userId, businessId]
  );
  return result.rows.length > 0;
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

/** Remove warnings on a to-do and reset users who have no other warnings. */
async function clearWarnings(todoId, client = db) {
  const warned = await client.query('SELECT DISTINCT user_id FROM warnings WHERE todo_id = $1', [todoId]);
  if (warned.rows.length === 0) return;
  await client.query('DELETE FROM warnings WHERE todo_id = $1', [todoId]);
  await client.query('UPDATE todos SET is_warned = FALSE WHERE id = $1', [todoId]);
  for (const w of warned.rows) {
    const remaining = await client.query('SELECT 1 FROM warnings WHERE user_id = $1 LIMIT 1', [w.user_id]);
    if (remaining.rows.length === 0) {
      await client.query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'warned'", [w.user_id]);
    }
  }
}

/** Who reviews finished work: the person who set it, or the next people up the chain if that was the finisher. */
async function reviewersFor(todo, actor) {
  if (todo.created_by !== actor.id) return [todo.created_by];
  return nextApprovers(todo.business_id, actorLevelIn(actor, todo.business_id), actor.id);
}

module.exports = { MAX_DEPTH, isAssignable, businessMemberIds, clearWarnings, reviewersFor };
