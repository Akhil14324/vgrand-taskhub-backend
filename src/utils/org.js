const db = require('../db');
const { hasPermission } = require('./permissions');

/**
 * Chain of command.
 *
 * Every person has a numeric level; a LOWER number means MORE senior.
 *   0  system owner account (role super_admin without an org placement)
 *   1  Chairman            ┐
 *   2  Chief of Staff      ├ leadership tier (users.org_level), sits above every business
 *   3  Director            ┘
 *   4+ business designations (user_businesses.designation), scoped to one business
 *
 * A person's level inside a business is the most senior of their leadership tier and
 * their designation in that business. Approvals, deletions and people management
 * only flow downwards: you can act on someone only if your level is strictly lower.
 */

const LEADERSHIP = {
  // Role names are not shown to people: the three tiers are the leadership circle, told apart only by authority.
  1: { key: 'chairman', label: 'Top authority' },
  2: { key: 'chief_of_staff', label: 'Senior authority' },
  3: { key: 'director', label: 'Authority' },
};

const DESIGNATIONS = {
  head: { label: 'Lead', level: 4 },
  manager: { label: 'Manager', level: 5 },
  accountant: { label: 'Accountant', level: 6 },
  supervisor: { label: 'Supervisor', level: 6 },
  coordinator: { label: 'Coordinator', level: 6 },
  member: { label: 'Member', level: 7 },
  intern: { label: 'Intern', level: 8 },
};

const OUTSIDER_LEVEL = 9;
// Designations at or above this level can see and manage every task in their business.
const BUSINESS_MANAGER_LEVEL = DESIGNATIONS.manager.level;

function isValidDesignation(key) {
  return Object.prototype.hasOwnProperty.call(DESIGNATIONS, key);
}

function designationLevel(key) {
  return (DESIGNATIONS[key] || DESIGNATIONS.member).level;
}

/** Permission role that matches a leadership tier. */
function roleForOrgLevel(orgLevel) {
  if (orgLevel === 1 || orgLevel === 2) return 'super_admin';
  if (orgLevel === 3) return 'admin';
  return 'user';
}

/** Leadership level of a user row ({ org_level, role }), or null if not leadership. */
function globalLevel(u) {
  if (!u) return null;
  if (u.org_level) return Number(u.org_level);
  if (u.role === 'super_admin') return 0;
  if (u.role === 'admin') return 3;
  return null;
}

function minLevel(...levels) {
  const vals = levels.filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.min(...vals) : OUTSIDER_LEVEL;
}

/** Level of a user row inside a business, given their designation there (or null). */
function levelWithDesignation(u, designation) {
  return minLevel(globalLevel(u), designation ? designationLevel(designation) : null);
}

function displayTitle(u, designation, membershipTitle) {
  if (u?.title) return u.title;
  if (u?.org_level && LEADERSHIP[u.org_level]) return 'Leadership circle';
  if (membershipTitle) return membershipTitle;
  if (designation && DESIGNATIONS[designation]) return DESIGNATIONS[designation].label;
  if (u?.role === 'super_admin') return 'Super Admin';
  if (u?.role === 'admin') return 'Admin';
  return null;
}

/**
 * Load everything needed to make permission decisions for one user.
 * Returns { id, name, username, role, org_level, global, memberships: Map<businessId, designation> }.
 */
async function loadActor(userId) {
  const result = await db.query(
    `SELECT u.id, u.name, u.username, u.role, u.org_level, u.title, u.status,
            COALESCE(json_agg(json_build_object('business_id', ub.business_id, 'designation', ub.designation))
              FILTER (WHERE ub.business_id IS NOT NULL), '[]') AS memberships
     FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const memberships = new Map();
  for (const m of row.memberships) memberships.set(Number(m.business_id), m.designation);
  // Per-person switches (see utils/permissions.js). Before the migration has run there is no table: no overrides.
  const perms = new Map();
  try {
    const overrides = await db.query('SELECT permission, allowed FROM user_permissions WHERE user_id = $1', [userId]);
    for (const p of overrides.rows) perms.set(p.permission, p.allowed);
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  const actor = { ...row, global: globalLevel(row), memberships, perms };
  actor.can = (key) => hasPermission(actor, key, actorBestLevel(actor));
  return actor;
}

function actorLevelIn(actor, businessId) {
  if (!actor) return OUTSIDER_LEVEL;
  return minLevel(actor.global, businessId && actor.memberships.has(Number(businessId))
    ? designationLevel(actor.memberships.get(Number(businessId)))
    : null);
}

/** Most senior level the actor holds anywhere. */
function actorBestLevel(actor) {
  if (!actor) return OUTSIDER_LEVEL;
  const levels = [...actor.memberships.values()].map(designationLevel);
  return minLevel(actor.global, ...levels);
}

function isLeader(actor) {
  return actor?.global !== null && actor?.global !== undefined && actor.global <= 3;
}

/** Super admin + chief of staff portal: full organisation management. */
function isPortalAdmin(actor) {
  return actor?.global !== null && actor?.global !== undefined && actor.global <= 2;
}

/** Can the actor see/manage every task of this business? */
function managesBusiness(actor, businessId) {
  return actorLevelIn(actor, businessId) <= BUSINESS_MANAGER_LEVEL;
}

/** Level of any user inside a business (single query). */
async function userLevelIn(userId, businessId) {
  const result = await db.query(
    `SELECT u.role, u.org_level, ub.designation
     FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $2
     WHERE u.id = $1`,
    [userId, businessId || null]
  );
  const row = result.rows[0];
  if (!row) return OUTSIDER_LEVEL;
  return levelWithDesignation(row, row.designation);
}

/** Most senior level a user holds anywhere (for org-wide comparisons). */
async function userBestLevel(userId) {
  const actor = await loadActor(userId);
  return actorBestLevel(actor);
}

/**
 * People who are "next up" the chain for a request raised at `requesterLevel`
 * inside `businessId`: the closest more-senior tier, e.g. a member's manager or head,
 * a head's directors. Falls back to any more-senior person if nobody is in between.
 */
async function nextApprovers(businessId, requesterLevel, excludeUserId) {
  const result = await db.query(
    `SELECT u.id, u.role, u.org_level, ub.designation
     FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $1
     WHERE u.status != 'inactive'
       AND u.id != $2
       AND (ub.user_id IS NOT NULL OR u.org_level IS NOT NULL OR u.role IN ('admin', 'super_admin'))`,
    [businessId || null, excludeUserId || 0]
  );
  const senior = result.rows
    .map((r) => ({ id: r.id, level: levelWithDesignation(r, r.designation) }))
    .filter((r) => r.level < requesterLevel && r.level > 0);
  if (senior.length === 0) {
    return result.rows.filter((r) => globalLevel(r) === 0).map((r) => r.id);
  }
  const closest = Math.max(...senior.map((r) => r.level));
  return senior.filter((r) => r.level === closest).map((r) => r.id);
}

module.exports = {
  LEADERSHIP,
  DESIGNATIONS,
  OUTSIDER_LEVEL,
  BUSINESS_MANAGER_LEVEL,
  isValidDesignation,
  designationLevel,
  roleForOrgLevel,
  globalLevel,
  levelWithDesignation,
  displayTitle,
  loadActor,
  actorLevelIn,
  actorBestLevel,
  isLeader,
  isPortalAdmin,
  managesBusiness,
  userLevelIn,
  userBestLevel,
  nextApprovers,
};
