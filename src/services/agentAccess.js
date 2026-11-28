// Stored side of agent access: registered agents, one-time codes and connections. Only hashes are kept.
const bcrypt = require('bcryptjs');
const db = require('../db');
const { sha256, newSecret, mayConnect, redirectMatches, verifierMatches } = require('../utils/agentRules');

const ACCESS_SECONDS = 60 * 60;
const REFRESH_DAYS = 30;
// Compared against when the username is unknown, so both answers take as long.
const NO_USER_HASH = bcrypt.hashSync(newSecret('none'), 10);

async function registerClient(name, redirectUris) {
  // Registrations that never got connected are cleared after a day, so the table cannot just grow.
  await db.query(
    `DELETE FROM agent_clients c WHERE c.created_at < NOW() - INTERVAL '1 day'
       AND NOT EXISTS (SELECT 1 FROM agent_grants g WHERE g.client_id = c.id)`
  );
  const id = newSecret('agent');
  await db.query('INSERT INTO agent_clients (id, name, redirect_uris) VALUES ($1, $2, $3)', [id, name, JSON.stringify(redirectUris)]);
  return id;
}

/** The registered agent, when it exists and may be answered at this address. */
async function clientFor(clientId, redirectUri) {
  if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return null;
  const row = (await db.query('SELECT * FROM agent_clients WHERE id = $1', [clientId])).rows[0];
  return row && redirectMatches(row.redirect_uris, redirectUri) ? row : null;
}

/** { user } or { error }: the same rules as the app, plus the pilot list. */
async function checkPassword(config, username, password) {
  const name = String(username || '').trim().slice(0, 255);
  const found = (await db.query(
    'SELECT id, name, username, password_hash, status, must_change_password FROM users WHERE LOWER(username) = LOWER($1)', [name]
  )).rows[0];
  const ok = await bcrypt.compare(String(password || ''), found?.password_hash || NO_USER_HASH);
  if (!found || !ok) return { error: 'Wrong username or password.' };
  if (found.status === 'inactive') return { error: 'This account is not active.' };
  if (found.must_change_password) return { error: 'Sign in to TaskHub and change your password first.' };
  if (!mayConnect(config, found.username)) return { error: 'AI agents are not switched on for your account yet.' };
  return { user: found };
}

async function createCode({ clientId, userId, redirectUri, challenge }) {
  const code = newSecret('code');
  await db.query('DELETE FROM agent_codes WHERE expires_at < NOW()');
  await db.query(
    `INSERT INTO agent_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '60 seconds')`,
    [sha256(code), clientId, userId, redirectUri, challenge]
  );
  return code;
}

const pair = () => ({ access: newSecret('tha'), refresh: newSecret('thr') });
const answer = ({ access, refresh }) => ({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: 'todos:read' });

/** Swap a code for tokens. The code is deleted on first use, right or wrong. Null when anything does not match. */
async function exchangeCode({ code, clientId, redirectUri, verifier }) {
  if (typeof code !== 'string') return null;
  const row = (await db.query(
    'DELETE FROM agent_codes WHERE code_hash = $1 RETURNING *, (expires_at > NOW()) AS alive', [sha256(code)]
  )).rows[0];
  if (!row || !row.alive || row.client_id !== clientId || row.redirect_uri !== redirectUri || !verifierMatches(verifier, row.code_challenge)) return null;
  const t = pair();
  await db.query(
    `INSERT INTO agent_grants (user_id, client_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5, NOW() + make_interval(days => $6))`,
    [row.user_id, clientId, sha256(t.access), ACCESS_SECONDS, sha256(t.refresh), REFRESH_DAYS]
  );
  return answer(t);
}

/** A refresh token works once. Showing a used one again means it leaked, so the connection is removed. */
async function refreshTokens({ refreshToken, clientId }) {
  if (typeof refreshToken !== 'string' || typeof clientId !== 'string') return null;
  const old = sha256(refreshToken);
  const t = pair();
  const done = await db.query(
    `UPDATE agent_grants SET access_hash = $3, access_expires_at = NOW() + make_interval(secs => $4),
            refresh_hash = $5, previous_refresh_hash = $1, refresh_expires_at = NOW() + make_interval(days => $6)
     WHERE refresh_hash = $1 AND client_id = $2 AND refresh_expires_at > NOW() RETURNING id`,
    [old, clientId, sha256(t.access), ACCESS_SECONDS, sha256(t.refresh), REFRESH_DAYS]
  );
  if (done.rows.length) return answer(t);
  await db.query('DELETE FROM agent_grants WHERE previous_refresh_hash = $1', [old]);
  return null;
}

/** Who an access token speaks for, or null. */
async function userForAccessToken(config, token) {
  const row = (await db.query(
    `SELECT g.id AS grant_id, u.id, u.name, u.username FROM agent_grants g JOIN users u ON u.id = g.user_id
     WHERE g.access_hash = $1 AND g.access_expires_at > NOW() AND u.status <> 'inactive' AND u.must_change_password IS NOT TRUE`,
    [sha256(token)]
  )).rows[0];
  if (!row || !mayConnect(config, row.username)) return null;
  await db.query(
    `UPDATE agent_grants SET last_used_at = NOW() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`,
    [row.grant_id]
  );
  return row;
}

async function revokeToken(token, clientId) {
  if (typeof token !== 'string' || typeof clientId !== 'string') return;
  const hash = sha256(token);
  await db.query('DELETE FROM agent_grants WHERE client_id = $2 AND (access_hash = $1 OR refresh_hash = $1)', [hash, clientId]);
}

async function connectionsOf(userId) {
  return (await db.query(
    `SELECT g.id, c.name, g.created_at, g.last_used_at FROM agent_grants g JOIN agent_clients c ON c.id = g.client_id
     WHERE g.user_id = $1 AND g.refresh_expires_at > NOW() ORDER BY g.created_at DESC`,
    [userId]
  )).rows;
}

async function removeConnection(userId, grantId) {
  const done = await db.query('DELETE FROM agent_grants WHERE id = $1 AND user_id = $2 RETURNING id', [grantId, userId]);
  return done.rows.length > 0;
}

module.exports = {
  registerClient, clientFor, checkPassword, createCode, exchangeCode, refreshTokens, userForAccessToken, revokeToken, connectionsOf, removeConnection,
};
