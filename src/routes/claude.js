const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor } = require('../utils/org');
const { getTodoFor, descendantIds, audienceIds } = require('../services/todoQueries');
const { notify, emitToUsers } = require('../utils/notify');
const {
  mentionsClaude, parseRepos, repoLabel, tokenForRepo, isClaudeUser, branchName, buildPrompt, verifySignature, isFresh, prNumberFromUrl,
  OPEN_STATUSES, CALLBACK_STATUSES, STALE_AFTER_MINUTES,
} = require('../utils/claudeRun');

/**
 * "Run with Claude". The developer (CLAUDE_ALLOWED_USERNAMES, default "akhil") presses a button on a
 * to-do that mentions @claude. Nobody else gets the button, the status card or any answer from these
 * endpoints (they look like they do not exist). Nothing runs by itself. The backend asks GitHub to start the `claude-task.yml`
 * workflow of the chosen repository; the workflow lets Claude Code do the work on a new branch, opens
 * a pull request and reports back to POST /callback (signed). Nothing reaches main until someone
 * presses Approve here, which merges that pull request; Reject closes it.
 *
 *   GET  /api/claude/todo/:id        mention + permissions + recent runs for the to-do panel
 *   POST /api/claude/todo/:id/run    { repo }  start a run
 *   POST /api/claude/runs/:id/approve | /reject
 *   POST /api/claude/callback        called by the workflow (HMAC of the raw body, CLAUDE_WEBHOOK_SECRET)
 */

const router = express.Router();

const REPOS = parseRepos(process.env.CLAUDE_REPOS);
const WORKFLOW_FILE = process.env.CLAUDE_WORKFLOW_FILE || 'claude-task.yml';
// Pull requests target each repository's own default branch (main, master, ...). Override for all with this.
const BASE_BRANCH_OVERRIDE = process.env.CLAUDE_BASE_BRANCH || null;

// One token per GitHub owner (CLAUDE_GITHUB_TOKEN_<OWNER>), else CLAUDE_GITHUB_TOKEN: a token cannot span owners.
const githubToken = (repo) => tokenForRepo(repo, process.env);
const webhookSecret = () => process.env.CLAUDE_WEBHOOK_SECRET;
/** The only people who may use Claude at all. */
const allowed = (actor) => isClaudeUser(actor?.username, process.env.CLAUDE_ALLOWED_USERNAMES);
const isConfigured = () => !!webhookSecret();

const runLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `claude-${req.user?.id || 'anon'}`,
  message: { error: 'Too many Claude runs, please try again later.' },
});

/** Where the workflow reports back to. CLAUDE_CALLBACK_URL wins; Railway's public domain is the fallback. */
function callbackUrl() {
  if (process.env.CLAUDE_CALLBACK_URL) return process.env.CLAUDE_CALLBACK_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/claude/callback`;
  return null;
}

async function github(method, path, body) {
  const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(path)?.[1];
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken(repo)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'taskhub-claude-runner',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!response.ok) {
    const err = new Error(data?.message || `GitHub answered ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

const RUN_SELECT = `
  SELECT r.id, r.todo_id, r.todo_title, r.repo_key, r.repo, r.status, r.branch, r.pr_number, r.pr_url, r.summary,
         r.triggered_by, tu.name AS triggered_by_name, r.decided_by, du.name AS decided_by_name, r.decided_at,
         r.created_at, r.updated_at
  FROM claude_runs r
  LEFT JOIN users tu ON tu.id = r.triggered_by
  LEFT JOIN users du ON du.id = r.decided_by`;

async function announce(run, action = 'claude') {
  if (!run.todo_id) return;
  try {
    emitToUsers(await audienceIds(run.todo_id), 'todo:changed', { todoId: Number(run.todo_id), action });
  } catch { /* live update only */ }
}

async function tell(run, title, body) {
  if (!run.triggered_by) return;
  await notify([run.triggered_by], { type: 'claude_run', title, body, data: { todoId: run.todo_id, runId: run.id } });
}

const clip = (text, max) => String(text || '').trim().slice(0, max);

// ---------------------------------------------------------------------------------------------------
// GET /todo/:id
// ---------------------------------------------------------------------------------------------------
router.get('/todo/:id', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    // Everyone else just gets "nothing here": the app shows no Claude UI for them.
    if (!allowed(actor)) return res.json({ enabled: false });
    const todo = await getTodoFor(req.params.id, actor.id, actor);
    if (!todo) return res.status(404).json({ error: 'To-do not found' });

    await db.query(
      `UPDATE claude_runs
         SET status = 'failed', summary = 'No answer from GitHub Actions. Check the workflow run and try again.', updated_at = NOW()
       WHERE todo_id = $1 AND status IN ('queued', 'running') AND created_at < NOW() - make_interval(mins => $2)`,
      [todo.id, STALE_AFTER_MINUTES]
    );

    const [comments, runs] = await Promise.all([
      db.query('SELECT body FROM todo_comments WHERE todo_id = $1', [todo.id]),
      db.query(`${RUN_SELECT} WHERE r.todo_id = $1 ORDER BY r.created_at DESC LIMIT 5`, [todo.id]),
    ]);
    const mentioned = mentionsClaude(todo.title, todo.notes, ...comments.rows.map((c) => c.body));
    const active = runs.rows.some((r) => OPEN_STATUSES.includes(r.status) && r.status !== 'pr_ready');

    res.json({
      enabled: true,
      mentioned,
      configured: isConfigured() && !!callbackUrl() && Object.values(REPOS).some((repo) => githubToken(repo)),
      can_run: mentioned && !active && !runs.rows.some((r) => r.status === 'pr_ready'),
      can_decide: true,
      repos: Object.keys(REPOS).filter((key) => githubToken(REPOS[key])).map((key) => ({ key, label: repoLabel(key) })),
      runs: runs.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------
// POST /todo/:id/run
// ---------------------------------------------------------------------------------------------------
router.post('/todo/:id/run', authenticate, runLimiter, async (req, res, next) => {
  let run = null;
  try {
    const actor = await loadActor(req.user.id);
    if (!allowed(actor)) return res.status(404).json({ error: 'Not found' });
    if (!isConfigured()) return res.status(503).json({ error: 'Claude runs are not set up yet (missing CLAUDE_WEBHOOK_SECRET on the server)' });
    const callback = callbackUrl();
    if (!callback) return res.status(503).json({ error: 'Claude runs are not set up yet (set CLAUDE_CALLBACK_URL on the server)' });

    const repoKey = String(req.body.repo || '');
    const repo = REPOS[repoKey];
    if (!repo) return res.status(400).json({ error: 'Choose which project Claude should work in' });
    if (!githubToken(repo)) return res.status(503).json({ error: `No GitHub token is set for ${repo.split('/')[0]} yet (CLAUDE_GITHUB_TOKEN_${repo.split('/')[0].toUpperCase().replace(/[^A-Z0-9]/g, '_')})` });

    const todo = await getTodoFor(req.params.id, actor.id, actor);
    if (!todo) return res.status(404).json({ error: 'To-do not found' });

    const [comments, kids] = await Promise.all([
      db.query(
        `SELECT c.body, COALESCE(u.name, 'Someone') AS author FROM todo_comments c
         LEFT JOIN users u ON u.id = c.user_id WHERE c.todo_id = $1 ORDER BY c.created_at`,
        [todo.id]
      ),
      descendantIds(todo.id).then((ids) => (ids.length
        ? db.query('SELECT title, notes, is_done FROM todos WHERE id = ANY($1::int[]) ORDER BY id', [ids])
        : { rows: [] })),
    ]);
    // The button only exists for to-dos that ask for Claude; enforce it here too.
    if (!mentionsClaude(todo.title, todo.notes, ...comments.rows.map((c) => c.body))) {
      return res.status(400).json({ error: 'Mention @claude in the title, notes or a comment first' });
    }

    // One open run per to-do, enforced by the insert itself so a double click cannot start two.
    const inserted = await db.query(
      `INSERT INTO claude_runs (todo_id, todo_title, repo_key, repo, triggered_by)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM claude_runs WHERE todo_id = $1 AND status IN ('queued', 'running', 'pr_ready'))
       RETURNING id`,
      [todo.id, clip(todo.title, 500), repoKey, repo, actor.id]
    );
    if (inserted.rows.length === 0) return res.status(409).json({ error: 'Claude already has an open run on this to-do' });
    run = { id: inserted.rows[0].id };

    const branch = branchName(run.id, todo.title);
    const prompt = buildPrompt({ title: todo.title, notes: todo.notes, subtasks: kids.rows, comments: comments.rows });
    let baseBranch = BASE_BRANCH_OVERRIDE;
    try {
      baseBranch = baseBranch || (await github('GET', `/repos/${repo}`)).default_branch || 'main';
      await github('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/dispatches`, {
        ref: baseBranch,
        inputs: {
          run_id: String(run.id),
          branch,
          task_title: clip(todo.title.replace(/@claude/gi, ''), 200) || 'Task',
          task_prompt: prompt,
          callback_url: callback,
        },
      });
    } catch (err) {
      const hint = err.status === 404
        ? `GitHub could not find ${WORKFLOW_FILE} on ${baseBranch || 'the default branch'} in ${repo}, or the token cannot reach that repository (or Actions is disabled there).`
        : err.message;
      await db.query(`UPDATE claude_runs SET status = 'failed', summary = $2, updated_at = NOW() WHERE id = $1`, [run.id, clip(hint, 500)]);
      return res.status(502).json({ error: `Could not start Claude: ${hint}` });
    }

    await db.query('UPDATE claude_runs SET branch = $2 WHERE id = $1', [run.id, branch]);
    const row = (await db.query(`${RUN_SELECT} WHERE r.id = $1`, [run.id])).rows[0];
    await announce(row);
    res.status(201).json(row);
  } catch (err) {
    if (run) await db.query(`UPDATE claude_runs SET status = 'failed', summary = 'Unexpected server error', updated_at = NOW() WHERE id = $1 AND status = 'queued'`, [run.id]).catch(() => {});
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------
// Approve (merge) / reject (close)
// ---------------------------------------------------------------------------------------------------
async function loadDecidable(req, res) {
  const actor = await loadActor(req.user.id);
  if (!allowed(actor)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  const run = (await db.query(`${RUN_SELECT} WHERE r.id = $1`, [parseInt(req.params.id, 10) || 0])).rows[0];
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return null;
  }
  if (!githubToken(run.repo)) {
    res.status(503).json({ error: `No GitHub token is set for ${run.repo.split('/')[0]} on the server` });
    return null;
  }
  if (run.status !== 'pr_ready' || !run.pr_number) {
    res.status(409).json({ error: 'This run has no pull request waiting for a decision' });
    return null;
  }
  return { actor, run };
}

/** The pull request must still be open and still be the branch Claude made for this run. */
async function checkPull(run) {
  const pull = await github('GET', `/repos/${run.repo}/pulls/${run.pr_number}`);
  if (pull.head?.ref !== run.branch) throw Object.assign(new Error('The pull request no longer matches this run'), { status: 409 });
  return pull;
}

const deleteBranch = (run) => github('DELETE', `/repos/${run.repo}/git/refs/heads/${run.branch}`).catch(() => {});

router.post('/runs/:id/approve', authenticate, async (req, res, next) => {
  try {
    const ctx = await loadDecidable(req, res);
    if (!ctx) return;
    const { actor, run } = ctx;
    const pull = await checkPull(run);
    if (pull.state !== 'open') {
      return res.status(409).json({ error: pull.merged ? 'This pull request is already merged' : 'This pull request was closed on GitHub' });
    }
    try {
      await github('PUT', `/repos/${run.repo}/pulls/${run.pr_number}/merge`, {
        merge_method: 'squash',
        commit_title: clip(`${run.todo_title.replace(/@claude/gi, '').trim()} (Claude, TaskHub #${run.todo_id || run.id})`, 200),
      });
    } catch (err) {
      const message = err.status === 405 || err.status === 409
        ? `GitHub will not merge it yet: ${err.message}. Fix it on GitHub (conflicts, required checks or branch rules) and try again.`
        : err.message;
      return res.status(err.status === 403 ? 403 : 409).json({ error: message });
    }
    await deleteBranch(run);
    await db.query(`UPDATE claude_runs SET status = 'merged', decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [run.id, actor.id]);
    const row = (await db.query(`${RUN_SELECT} WHERE r.id = $1`, [run.id])).rows[0];
    await announce(row);
    res.json(row);
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status === 404 ? 409 : err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/runs/:id/reject', authenticate, async (req, res, next) => {
  try {
    const ctx = await loadDecidable(req, res);
    if (!ctx) return;
    const { actor, run } = ctx;
    await checkPull(run);
    await github('PATCH', `/repos/${run.repo}/pulls/${run.pr_number}`, { state: 'closed' });
    await deleteBranch(run);
    await db.query(`UPDATE claude_runs SET status = 'rejected', decided_by = $2, decided_at = NOW(), updated_at = NOW() WHERE id = $1`, [run.id, actor.id]);
    const row = (await db.query(`${RUN_SELECT} WHERE r.id = $1`, [run.id])).rows[0];
    await announce(row);
    res.json(row);
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status === 404 ? 409 : err.status).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------
// POST /callback — the workflow reports progress. No login: the body is signed with CLAUDE_WEBHOOK_SECRET.
//   { run_id, status: running|pr_ready|no_changes|failed, pr_url?, pr_number?, summary?, ts }
// ---------------------------------------------------------------------------------------------------
router.post('/callback', async (req, res, next) => {
  try {
    const secret = webhookSecret();
    const signature = req.get('x-claude-signature');
    if (!secret || !req.rawBody || !verifySignature(secret, req.rawBody, signature)) {
      return res.status(401).json({ error: 'Bad signature' });
    }
    const { run_id: runId, status, pr_url: prUrl, summary, ts } = req.body || {};
    if (!isFresh(ts)) return res.status(401).json({ error: 'Stale request' });
    if (!CALLBACK_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });

    const prNumber = Number(req.body.pr_number) || prNumberFromUrl(prUrl);
    if (status === 'pr_ready' && !prNumber) return res.status(400).json({ error: 'pr_ready needs the pull request' });
    const safeUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(String(prUrl || '')) ? prUrl : null;

    const updated = await db.query(
      `UPDATE claude_runs
         SET status = $2,
             pr_number = COALESCE($3, pr_number),
             pr_url = COALESCE($4, pr_url),
             summary = COALESCE($5, summary),
             updated_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING id, todo_id, todo_title, triggered_by, status`,
      [parseInt(runId, 10) || 0, status, status === 'pr_ready' ? prNumber : null, safeUrl, summary ? clip(summary, 4000) : null]
    );
    const run = updated.rows[0];
    if (!run) return res.json({ ok: true, ignored: true }); // unknown run, or already finished

    await announce(run);
    const name = String(run.todo_title || 'your task').replace(/@claude/gi, '').trim() || 'your task';
    if (status === 'pr_ready') await tell(run, 'Claude finished a change', `"${name}" is ready for your review. Approve it to merge into main.`);
    if (status === 'no_changes') await tell(run, 'Claude made no changes', `Claude looked at "${name}" but did not change any code.`);
    if (status === 'failed') await tell(run, 'Claude could not finish', `The run for "${name}" failed. Open the task for details.`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
