const crypto = require('crypto');
const { isValidDesignation } = require('../utils/org');

const PASSWORD_WORDS = ['Sunrise', 'Harbor', 'Maple', 'Summit', 'Falcon', 'River', 'Cedar', 'Comet', 'Lotus', 'Tiger'];

/** Friendly temporary password that satisfies validatePassword (upper, lower, digit, 8+). */
function generateTempPassword() {
  const word = PASSWORD_WORDS[crypto.randomInt(PASSWORD_WORDS.length)];
  return `${word}${crypto.randomInt(1000, 10000)}`;
}

/**
 * Make sure a business has its group chat and that every leader and member is in it.
 * `q` is any object with a pg-style query(text, params) method.
 */
async function ensureBusinessGroup(q, businessId) {
  const biz = await q.query('SELECT id, name FROM businesses WHERE id = $1', [businessId]);
  if (!biz.rows.length) return null;

  let conv = await q.query(
    `SELECT id FROM conversations WHERE business_id = $1 AND type = 'group' ORDER BY id LIMIT 1`,
    [businessId]
  );
  if (!conv.rows.length) {
    const owner = await q.query(
      `SELECT id FROM users WHERE role = 'super_admin' ORDER BY org_level NULLS FIRST, id LIMIT 1`
    );
    if (!owner.rows.length) return null;
    conv = await q.query(
      `INSERT INTO conversations (type, name, business_id, created_by) VALUES ('group', $1, $2, $3) RETURNING id`,
      [biz.rows[0].name, businessId, owner.rows[0].id]
    );
  }
  const conversationId = conv.rows[0].id;

  await q.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, is_admin, is_invisible)
     SELECT $1, u.id, FALSE, u.role = 'super_admin'
     FROM users u
     WHERE u.status != 'inactive'
       AND (u.role IN ('admin', 'super_admin')
            OR EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = u.id AND ub.business_id = $2))
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [conversationId, businessId]
  );
  return conversationId;
}

async function addToBusinessGroups(q, userId, businessIds, invisible = false) {
  if (!businessIds.length) return;
  await q.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, is_admin, is_invisible)
     SELECT c.id, $1, FALSE, $3 FROM conversations c
     WHERE c.type = 'group' AND c.business_id = ANY($2::int[])
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [userId, businessIds, invisible]
  );
}

async function removeFromBusinessGroups(q, userId, businessIds) {
  if (!businessIds.length) return;
  await q.query(
    `DELETE FROM conversation_participants cp
     USING conversations c
     WHERE cp.conversation_id = c.id AND c.type = 'group' AND c.business_id = ANY($2::int[]) AND cp.user_id = $1`,
    [userId, businessIds]
  );
}

/**
 * Replace a person's business memberships.
 * memberships: [{ business_id, designation, title? }]
 * Returns { added: number[], removed: number[] } business ids.
 */
async function setMemberships(q, userId, memberships) {
  const clean = [];
  const seen = new Set();
  for (const m of memberships || []) {
    const businessId = Number(m.business_id);
    if (!businessId || seen.has(businessId)) continue;
    seen.add(businessId);
    clean.push({
      business_id: businessId,
      designation: isValidDesignation(m.designation) ? m.designation : 'member',
      title: m.title ? String(m.title).trim().slice(0, 100) || null : null,
    });
  }

  const before = await q.query('SELECT business_id FROM user_businesses WHERE user_id = $1', [userId]);
  const beforeIds = before.rows.map((r) => r.business_id);
  const afterIds = clean.map((m) => m.business_id);
  const removed = beforeIds.filter((id) => !afterIds.includes(id));
  const added = afterIds.filter((id) => !beforeIds.includes(id));

  if (removed.length) {
    await q.query('DELETE FROM user_businesses WHERE user_id = $1 AND business_id = ANY($2::int[])', [userId, removed]);
  }
  for (const m of clean) {
    await q.query(
      `INSERT INTO user_businesses (user_id, business_id, designation, title)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, business_id) DO UPDATE SET designation = EXCLUDED.designation, title = EXCLUDED.title`,
      [userId, m.business_id, m.designation, m.title]
    );
  }

  const roleRow = await q.query('SELECT role FROM users WHERE id = $1', [userId]);
  const role = roleRow.rows[0]?.role;
  await addToBusinessGroups(q, userId, added, role === 'super_admin');
  // Leaders stay in every business group even without a membership.
  if (!['admin', 'super_admin'].includes(role)) await removeFromBusinessGroups(q, userId, removed);

  await q.query('UPDATE users SET business_id = $1 WHERE id = $2', [afterIds[0] || null, userId]);
  return { added, removed };
}

/** After a role change, join (leaders) or leave (others) business group chats. */
async function syncLeaderGroups(q, userId, role) {
  if (['admin', 'super_admin'].includes(role)) {
    const all = await q.query(`SELECT DISTINCT business_id FROM conversations WHERE type = 'group' AND business_id IS NOT NULL`);
    await addToBusinessGroups(q, userId, all.rows.map((r) => r.business_id), role === 'super_admin');
    await q.query(
      `UPDATE conversation_participants cp SET is_invisible = $2
       FROM conversations c
       WHERE cp.conversation_id = c.id AND c.type = 'group' AND c.business_id IS NOT NULL AND cp.user_id = $1`,
      [userId, role === 'super_admin']
    );
    return;
  }
  const mine = await q.query('SELECT business_id FROM user_businesses WHERE user_id = $1', [userId]);
  const keep = mine.rows.map((r) => r.business_id);
  await q.query(
    `DELETE FROM conversation_participants cp
     USING conversations c
     WHERE cp.conversation_id = c.id AND c.type = 'group' AND c.business_id IS NOT NULL
       AND cp.user_id = $1 AND NOT (c.business_id = ANY($2::int[]))`,
    [userId, keep]
  );
  await q.query(
    `UPDATE conversation_participants cp SET is_invisible = FALSE
     FROM conversations c
     WHERE cp.conversation_id = c.id AND c.type = 'group' AND cp.user_id = $1`,
    [userId]
  );
}

module.exports = {
  generateTempPassword,
  ensureBusinessGroup,
  setMemberships,
  syncLeaderGroups,
};
