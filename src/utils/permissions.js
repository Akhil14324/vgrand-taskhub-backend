/**
 * Module permissions. Every feature that can be switched per person has a key here with a default
 * that follows the chain of command (lower level number = more senior). A row in `user_permissions`
 * overrides the default for one person, in either direction. The owner (level 0) always has everything.
 */

const PERMISSIONS = [
  { key: 'monitor', label: 'Team monitor', description: 'Watch the to-dos and numbers of people below them', defaultMaxLevel: 4 },
  { key: 'insights', label: 'Business health and workload', description: 'See health scores and how full each person is', defaultMaxLevel: 4 },
  { key: 'leaderboard_company', label: 'Company-wide leaderboard', description: 'See the leaderboard for every business, not just their own', defaultMaxLevel: 3 },
  { key: 'manage_people', label: 'Manage people', description: 'Add, edit and remove people and reset passwords', defaultMaxLevel: 2 },
  { key: 'manage_businesses', label: 'Manage businesses', description: 'Create, edit and delete businesses', defaultMaxLevel: 3 },
  { key: 'view_all_todos', label: 'See every to-do', description: 'See every personal to-do and business task, whoever owns it', defaultMaxLevel: 0 },
  { key: 'chat_audit', label: 'Read every chat', description: 'Open any conversation, including other people\'s direct chats', defaultMaxLevel: 0 },
  { key: 'manage_access', label: 'Manage access', description: 'Switch these permissions on and off for people below them', defaultMaxLevel: 3 },
];

const KEYS = new Set(PERMISSIONS.map((p) => p.key));

function isPermissionKey(key) {
  return KEYS.has(key);
}

/** The default for a person whose best (most senior) level is `level`. */
function defaultAllowed(key, level) {
  const def = PERMISSIONS.find((p) => p.key === key);
  if (!def) return false;
  return level !== null && level !== undefined && level <= def.defaultMaxLevel;
}

/**
 * Effective answer for an actor from loadActor() ({ global, perms: Map<key, boolean>, level }).
 * `bestLevel` is the actor's most senior level anywhere (actorBestLevel).
 */
function hasPermission(actor, key, bestLevel) {
  if (!actor) return false;
  if (actor.global === 0) return true;
  if (actor.perms && actor.perms.has(key)) return actor.perms.get(key);
  return defaultAllowed(key, bestLevel);
}

module.exports = { PERMISSIONS, isPermissionKey, defaultAllowed, hasPermission };
