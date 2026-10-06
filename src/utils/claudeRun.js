const crypto = require('crypto');

/**
 * Pure helpers for "Run with Claude" (routes/claude.js). No database, no network: unit-tested.
 */

const MENTION = /(^|[^A-Za-z0-9_.-])@claude(?![A-Za-z0-9_-])/i;
const OPEN_STATUSES = ['queued', 'running', 'pr_ready'];
const CALLBACK_STATUSES = ['running', 'pr_ready', 'no_changes', 'failed'];
const SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000;
// A run that never reports back (workflow deleted, runner lost) is shown as failed after this long.
const STALE_AFTER_MINUTES = 60;

/** Does any of the given texts mention @claude? ("@claudette" and "me@claude.com" do not count.) */
function mentionsClaude(...texts) {
  return texts.some((text) => MENTION.test(String(text || '')));
}

/**
 * CLAUDE_REPOS="mobile=owner/web-repo,backend=owner/api-repo" -> { mobile: 'owner/web-repo', ... }.
 * Falls back to this project's two repositories.
 */
function parseRepos(raw) {
  const text = String(raw || '').trim()
    || 'mobile=Akhil14324/Taskhub-mobile,backend=Akhil14324/vgrand-taskhub-backend';
  const repos = {};
  for (const part of text.split(',')) {
    const [key, repo] = part.split('=').map((s) => s && s.trim());
    if (key && /^[a-z][a-z0-9_-]{0,19}$/.test(key) && /^[\w.-]+\/[\w.-]+$/.test(repo || '')) repos[key] = repo;
  }
  return repos;
}

/** "claude-app" -> "Claude app"; the two original keys keep their short names. */
function repoLabel(key) {
  const fixed = { mobile: 'Web app', backend: 'Backend' };
  if (fixed[key]) return fixed[key];
  const text = String(key || '').replace(/[-_]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** CLAUDE_ALLOWED_USERNAMES="akhil,someone" (default "akhil"): who may use Claude at all. */
function isClaudeUser(username, raw) {
  const names = String(raw || 'akhil').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  return !!username && names.includes(String(username).toLowerCase());
}

/**
 * The GitHub token for a repository: CLAUDE_GITHUB_TOKEN_<OWNER> (owner upper-cased, anything that is
 * not a letter or digit becomes "_"), else CLAUDE_GITHUB_TOKEN. A fine-grained token only covers one owner.
 */
function tokenForRepo(repo, env = process.env) {
  const owner = String(repo || '').split('/')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return (owner && env[`CLAUDE_GITHUB_TOKEN_${owner}`]) || env.CLAUDE_GITHUB_TOKEN || null;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/@claude/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '') || 'task';
}

/** claude/task-<run>-<slug>: the run id keeps branches unique when a task is run twice. */
function branchName(runId, title) {
  return `claude/task-${runId}-${slugify(title)}`;
}

const clip = (text, max) => {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * The task as Claude sees it: title, notes, sub-tasks and the discussion. The "@claude" word itself
 * is dropped from the title/notes: it is the trigger, not part of the request.
 */
function buildPrompt({ title, notes, subtasks = [], comments = [] }, { maxLength = 20000 } = {}) {
  const strip = (s) => String(s || '').replace(/(^|\s)@claude\b/gi, '$1').replace(/[ \t]+\n/g, '\n').trim();
  const lines = [`Task: ${clip(strip(title), 500)}`];
  if (strip(notes)) lines.push('', 'Details:', clip(strip(notes), 6000));
  const subs = subtasks.filter((s) => s && s.title);
  if (subs.length) {
    lines.push('', 'Sub-tasks:');
    for (const s of subs.slice(0, 30)) {
      lines.push(`- [${s.is_done ? 'x' : ' '}] ${clip(strip(s.title), 200)}${strip(s.notes) ? ` — ${clip(strip(s.notes), 400)}` : ''}`);
    }
  }
  const talk = comments.filter((c) => c && c.body);
  if (talk.length) {
    lines.push('', 'Discussion (oldest first):');
    for (const c of talk.slice(-20)) lines.push(`- ${c.author || 'Someone'}: ${clip(strip(c.body), 600)}`);
  }
  return clip(lines.join('\n'), maxLength);
}

/** HMAC-SHA256 of the exact request body, as sent by the workflow: "sha256=<hex>". */
function signBody(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function verifySignature(secret, body, signature) {
  if (!secret || !signature || !body) return false;
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The callback payload carries a timestamp (ms) so an old signed request cannot be replayed. */
function isFresh(ts, now = Date.now()) {
  const n = Number(ts);
  return Number.isFinite(n) && Math.abs(now - n) <= SIGNATURE_MAX_AGE_MS;
}

/** Pull request number out of a GitHub PR URL. */
function prNumberFromUrl(url) {
  const m = /\/pull\/(\d+)(?:$|[/?#])/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

module.exports = {
  mentionsClaude,
  parseRepos,
  repoLabel,
  tokenForRepo,
  isClaudeUser,
  slugify,
  branchName,
  buildPrompt,
  signBody,
  verifySignature,
  isFresh,
  prNumberFromUrl,
  OPEN_STATUSES,
  CALLBACK_STATUSES,
  STALE_AFTER_MINUTES,
};
