const db = require('../db');

// Usernames are letters, digits, dot, underscore and hyphen (see USERNAME_PATTERN).
const MENTION_REGEX = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9._-]{2,50})/g;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;
const USERNAME_RULE = 'Username must be lowercase letters, numbers, dot, dash or underscore (3–30 characters, no spaces)';

/** Usernames are always stored lowercase, so "Akhil" and "akhil" are the same name. */
function cleanUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** A free, lowercase username derived from a person's name: "V Akhil" -> "vakhil", then "vakhil2", ... */
async function suggestUsername(name, exec = db) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  if (base.length < 3) base = (base + 'user').slice(0, 24);
  for (let i = 0; i < 200; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    const taken = await exec.query('SELECT 1 FROM users WHERE LOWER(username) = $1', [candidate]);
    if (taken.rows.length === 0) return candidate;
  }
  return `${base}${Date.now() % 100000}`;
}

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

module.exports = { extractMentions, resolveMentions, USERNAME_PATTERN, USERNAME_RULE, cleanUsername, suggestUsername };
