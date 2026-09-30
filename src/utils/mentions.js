const db = require('../db');

// Usernames are letters, digits, dot, underscore and hyphen (see USERNAME_PATTERN).
const MENTION_REGEX = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9._-]{2,50})/g;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,30}$/;

/** Extract @usernames from free text (lower-cased, unique). */
function extractMentions(text) {
  if (!text) return [];
  const names = new Set();
  for (const match of String(text).matchAll(MENTION_REGEX)) {
    names.add(match[2].replace(/[.-]+$/, '').toLowerCase());
  }
  return [...names].filter(Boolean);
}

/**
 * Resolve mentioned users from text and/or explicit ids chosen in the autocomplete.
 * Returns active user rows { id, name, username }.
 */
async function resolveMentions(text, explicitIds = []) {
  const names = extractMentions(text);
  const ids = (Array.isArray(explicitIds) ? explicitIds : []).map(Number).filter(Boolean);
  if (names.length === 0 && ids.length === 0) return [];
  const result = await db.query(
    `SELECT id, name, username FROM users
     WHERE status != 'inactive'
       AND (LOWER(username) = ANY($1::text[]) OR id = ANY($2::int[]))`,
    [names, ids]
  );
  return result.rows;
}

module.exports = { extractMentions, resolveMentions, USERNAME_PATTERN };
