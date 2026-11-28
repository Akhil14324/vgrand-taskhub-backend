// Pure rules of the hosted MCP server: when it is on, who may connect, and the OAuth checks. Tests: agentRules.test.js.
const crypto = require('crypto');

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const APP_SCHEMES = ['cursor:', 'vscode:', 'vscode-insiders:'];

/**
 * { on, reason, base, allowed }. Off unless MCP_ENABLED=true. In production it also needs an https address and
 * OPEN_PASSWORD_RESET=false: while anyone can set anyone's password, signing in proves nothing.
 */
function mcpConfig(env = process.env) {
  const off = (reason) => ({ on: false, reason, base: null, allowed: [] });
  if (String(env.MCP_ENABLED || '').toLowerCase() !== 'true') return off('MCP_ENABLED is not true');
  const production = env.NODE_ENV === 'production';
  const address = env.MCP_PUBLIC_URL || env.PUBLIC_API_URL
    || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')
    || (production ? '' : `http://localhost:${env.PORT || 5000}`);
  let url;
  try { url = new URL(address); } catch { return off('MCP_PUBLIC_URL is missing or not an address'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname) && !production)) {
    return off('the public address must be https');
  }
  if (production && String(env.OPEN_PASSWORD_RESET || '').toLowerCase() !== 'false') {
    return off('set OPEN_PASSWORD_RESET=false first');
  }
  const allowed = String(env.MCP_ALLOWED_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { on: true, reason: null, base: url.origin, allowed };
}

/** MCP_ALLOWED_USERNAMES: names, or * for everyone. Empty means nobody. */
const mayConnect = (config, username) => config.allowed.includes('*') || config.allowed.includes(String(username || '').toLowerCase());

/** Where an agent may be sent back to: https, this computer, or a known desktop app. No fragments or credentials. */
function validRedirect(value) {
  if (typeof value !== 'string' || value.length > 600) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.includes(url.hostname);
  return APP_SCHEMES.includes(url.protocol);
}

/** Exact match, except that an address on this computer may come back on another port (RFC 8252). */
function redirectMatches(registered, asked) {
  if (!validRedirect(asked)) return false;
  return registered.some((r) => {
    if (r === asked) return true;
    const a = new URL(r);
    const b = new URL(asked);
    if (a.protocol !== 'http:' || !LOOPBACK.includes(a.hostname)) return false;
    a.port = ''; b.port = '';
    return a.href === b.href;
  });
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const newSecret = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
const validChallenge = (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c);

/** PKCE S256: the verifier shown now must hash to the challenge given at sign-in. */
function verifierMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !validChallenge(challenge)) return false;
  const made = crypto.createHash('sha256').update(verifier).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(made), Buffer.from(challenge));
}

module.exports = { mcpConfig, mayConnect, validRedirect, redirectMatches, sha256, newSecret, validChallenge, verifierMatches };
