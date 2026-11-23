const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor } = require('../utils/org');
const { listTodos, getTodoFor } = require('../services/todoQueries');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');
const { chatTools, configured } = require('../utils/openai');
const { businessHealth } = require('../services/insights');
const { atRisk } = require('../services/risk');
const { callApi, mustCall } = require('../services/automation/internalApi');
const { chatJSON } = require('../utils/openai');
const insights = require('../services/assistantInsights');

// /api/assistant: a chief of staff you can talk to. It answers from the person's own view of the data and
// never changes anything on its own: changes come back as proposals the person confirms, and are then made
// through the app's normal API as that person, so every permission and notification rule applies.
const router = express.Router();

const str = (v, n = 300) => sanitizeText(String(v ?? ''), n) || '';

/** "Recent AI activity" (migration 072). Never fails the request it belongs to. */
async function logActivity(userId, kind, summary) {
  try {
    await db.query('INSERT INTO assistant_activity (user_id, kind, summary) VALUES ($1, $2, $3)', [userId, kind, String(summary).slice(0, 300)]);
  } catch (err) {
    if (err.code !== '42P01') console.error('[assistant] activity log failed:', err.message);
  }
}
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

// ---- tools the model can use ------------------------------------------------------------------------

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const READ_TOOLS = [
  fn('search_todos', 'Find to-dos and business tasks the person can see. Always use this to get ids before proposing a change.', {
    query: { type: 'string', description: 'words in the title or notes' },
    assignee: { type: 'string', description: 'name or username of the person it is assigned to' },
    status: { type: 'string', enum: ['open', 'done', 'late', 'blocked'] },
    business: { type: 'string', description: 'business name' },
    due_before: { type: 'string', description: 'YYYY-MM-DD' },
    due_after: { type: 'string', description: 'YYYY-MM-DD' },
  }),
  fn('my_plan', 'Today\'s plan for the person: what to do, in order, with times.'),
  fn('at_risk', 'To-dos that look likely to miss their date, with the reasons.'),
  fn('team_status', 'How each business is doing this week (leaders only): finished, open, overdue, stuck.'),
  fn('find_person', 'Look up a colleague by name or username.', { name: { type: 'string' } }, ['name']),
  fn('recall', 'Search the company memory (to-dos, comments, updates, meeting summaries and decisions) to answer "what did we decide / who did / when did" questions.', { question: { type: 'string' } }, ['question']),
  fn('overview', 'The person\'s own numbers right now: due today, pending, completed today, overdue, no date, not updated, waiting on others, upcoming deadlines, date clashes, and data-based insights. Use it for "what should I do today", "show my pending / overdue tasks" and workload questions.'),
  fn('assigned_work', 'To-dos assigned TO the person by others, or assigned BY the person to others, with status, progress and last update.', {
    direction: { type: 'string', enum: ['to_me', 'by_me'] },
    status: { type: 'string', enum: ['open', 'overdue', 'stale', 'done'] },
  }, ['direction']),
  fn('stale_todos', 'Open to-dos (the person\'s own and the ones they gave out) not updated for a number of days.', { days: { type: 'integer', description: 'default 3' } }),
  fn('team_workload', 'Open, overdue, due-this-week and stuck work per person the person can see, and who is overloaded or light.'),
  fn('progress_report', 'Daily or weekly progress report from the data: completed, pending, delayed, progress %, trend.', { period: { type: 'string', enum: ['day', 'week'] } }, ['period']),
];

const WRITE_TOOLS = [
  fn('create_todo', 'Propose a new to-do, optionally for someone else, with steps.', {
    title: { type: 'string' }, assignee_username: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD' },
    due_time: { type: 'string', description: 'HH:MM' }, priority: { type: 'integer', description: '1 highest to 4' },
    steps: { type: 'array', items: { type: 'string' } },
  }, ['title']),
  fn('reschedule_todo', 'Propose moving a to-do to another date.', { id: { type: 'integer' }, due_date: { type: 'string' }, due_time: { type: 'string' } }, ['id', 'due_date']),
  fn('complete_todo', 'Propose ticking a to-do as done.', { id: { type: 'integer' } }, ['id']),
  fn('assign_todo', 'Propose giving a to-do to someone.', { id: { type: 'integer' }, username: { type: 'string' } }, ['id', 'username']),
  fn('add_comment', 'Propose a comment on a to-do.', { id: { type: 'integer' }, text: { type: 'string' } }, ['id', 'text']),
  fn('add_steps', 'Propose adding steps (sub-tasks) to a to-do. Use it to break a big task into smaller ones.', { id: { type: 'integer' }, steps: { type: 'array', items: { type: 'string' } } }, ['id', 'steps']),
  fn('set_priority', 'Propose a new priority for a to-do (1 highest, 4 lowest).', { id: { type: 'integer' }, priority: { type: 'integer' } }, ['id', 'priority']),
];
const WRITE_NAMES = new Set(WRITE_TOOLS.map((t) => t.function.name));

async function findUsers(name) {
  const q = `%${str(name, 60).replace(/^@/, '')}%`;
  return (await db.query(
    `SELECT id, name, username FROM users WHERE status <> 'inactive' AND (name ILIKE $1 OR username ILIKE $1) ORDER BY name LIMIT 5`, [q]
  )).rows;
}

const slim = (t) => ({
  id: t.id, title: t.title, status: t.is_done ? 'done' : t.status, due_date: t.due_date || null,
  assignee: t.assignee_name || null, business: t.business_name || null, steps: undefined,
});

async function searchTodos(actor, a) {
  const where = ['TRUE'];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length + 4}`; };
  if (a.query) { const p = add(`%${str(a.query, 100)}%`); where.push(`(t.title ILIKE ${p} OR t.notes ILIKE ${p})`); }
  if (a.assignee) {
    const ids = (await findUsers(a.assignee)).map((u) => u.id);
    if (!ids.length) return [];
    where.push(`t.assignee_id = ANY(${add(ids)}::int[])`);
  }
  if (a.status === 'open') where.push('t.is_done = FALSE');
  if (a.status === 'done') where.push('t.is_done = TRUE');
  if (a.status === 'late') where.push(`t.is_done = FALSE AND t.due_date < ${add(todayInAppZone())}::date`);
  if (a.status === 'blocked') where.push("t.status = 'blocked' AND t.is_done = FALSE");
  if (a.business) where.push(`t.business_id IN (SELECT id FROM businesses WHERE name ILIKE ${add(`%${str(a.business, 80)}%`)})`);
  if (isDate(a.due_before)) where.push(`t.due_date <= ${add(a.due_before)}::date`);
  if (isDate(a.due_after)) where.push(`t.due_date >= ${add(a.due_after)}::date`);
  const rows = await listTodos(actor.id, { actor, where: where.join(' AND '), params, tail: 'ORDER BY t.due_date NULLS LAST, t.id DESC LIMIT 25' });
  return rows.map(slim);
}

const STOP = new Set(['what', 'when', 'where', 'which', 'who', 'did', 'does', 'have', 'with', 'about', 'that', 'this', 'from', 'were', 'the', 'and', 'for', 'was', 'our', 'we', 'decide', 'decided']);

/** Company memory: matches in to-dos, comments, updates, meeting summaries and review notes the person may see. */
async function recall(actor, question) {
  const words = [...new Set(str(question, 300).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 6);
  if (!words.length) return [];
  const like = words.map((w) => `%${w}%`);
  const hits = [];
  const push = (rows, source, text) => rows.forEach((r) => hits.push({ source, todo_id: r.todo_id, when: r.at, text: text(r) }));
  push((await db.query(
    `SELECT c.todo_id, c.created_at AS at, c.body FROM todo_comments c WHERE c.body ILIKE ANY($1::text[]) ORDER BY c.created_at DESC LIMIT 25`, [like]
  )).rows, 'comment', (r) => r.body);
  push((await db.query(
    `SELECT e.todo_id, e.created_at AS at, e.kind, e.to_value, e.note FROM todo_events e
     WHERE e.todo_id IS NOT NULL AND e.kind IN ('update', 'step_reviewed', 'blocker_raised', 'blocker_cleared') AND e.note ILIKE ANY($1::text[])
     ORDER BY e.created_at DESC LIMIT 25`, [like]
  )).rows, 'update', (r) => `${r.to_value ? `${r.to_value}: ` : ''}${r.note}`);
  push((await db.query(
    `SELECT m.todo_id, m.created_at AS at, m.extracted FROM todo_meetings m WHERE m.extracted IS NOT NULL AND m.extracted::text ILIKE ANY($1::text[])
     ORDER BY m.created_at DESC LIMIT 15`, [like]
  )).rows, 'meeting', (r) => `${r.extracted.summary || ''} ${(r.extracted.decisions || []).join('; ')}`.trim());
  push((await db.query(
    `SELECT t.id AS todo_id, t.updated_at AS at, t.title, t.notes FROM todos t WHERE t.title ILIKE ANY($1::text[]) OR t.notes ILIKE ANY($1::text[])
     ORDER BY t.updated_at DESC LIMIT 25`, [like]
  )).rows, 'todo', (r) => `${r.title}${r.notes ? ` - ${r.notes}` : ''}`);

  // Only what the person is allowed to see.
  const ids = [...new Set(hits.map((h) => h.todo_id).filter(Boolean))];
  if (!ids.length) return [];
  const seen = await listTodos(actor.id, { actor, where: 't.id = ANY($5::int[])', params: [ids] });
  const titles = new Map(seen.map((t) => [t.id, t.title]));
  return hits.filter((h) => titles.has(h.todo_id)).slice(0, 18).map((h) => ({
    source: h.source, todo: titles.get(h.todo_id), todo_id: h.todo_id, when: h.when ? new Date(h.when).toISOString().slice(0, 10) : null, text: String(h.text || '').slice(0, 320),
  }));
}

async function runRead(actor, name, args) {
  switch (name) {
    case 'search_todos': return searchTodos(actor, args);
    case 'my_plan': return (await callApi(actor.id, 'GET', '/plan')).data;
    case 'at_risk': return atRisk(actor);
    case 'team_status': {
      if (!actor.can('insights')) return { error: 'Only leaders can see business status' };
      const h = await businessHealth(actor, 7);
      return h.businesses.map((b) => ({ name: b.name, score: b.score, open: b.open, overdue: b.overdue, blocked: b.blocked, finished_this_week: b.completed, on_time_rate: b.on_time_rate }));
    }
    case 'find_person': return findUsers(args.name);
    case 'recall': return recall(actor, args.question);
    case 'overview': {
      const o = insights.buildOverview(await insights.loadRows(actor), actor);
      return { today: o.today, counts: o.counts, due_today: o.due_today, overdue: o.overdue, upcoming: o.upcoming, stale: o.stale, waiting_on_others: o.waiting_on_others, conflicts: o.conflicts, insights: o.insights.map((i) => i.text) };
    }
    case 'assigned_work': {
      const rows = await insights.loadRows(actor);
      const { toMe, byMe } = insights.classify(rows, actor.id);
      const today = todayInAppZone();
      let list = args.direction === 'by_me' ? byMe : toMe;
      if (args.status === 'done') list = list.filter((t) => t.is_done);
      else {
        list = list.filter((t) => !t.is_done);
        if (args.status === 'overdue') list = list.filter((t) => insights.keyDate(t) && insights.keyDate(t) < today);
        if (args.status === 'stale') list = list.filter((t) => Date.now() - new Date(t.updated_at).getTime() >= insights.STALE_DAYS * 86400000);
      }
      return list.slice(0, 30).map((t) => insights.slimTodo(t));
    }
    case 'stale_todos': {
      const days = Math.min(60, Math.max(1, parseInt(args.days, 10) || insights.STALE_DAYS));
      const { mine, byMe } = insights.classify(await insights.loadRows(actor), actor.id);
      const cut = Date.now() - days * 86400000;
      return [...mine, ...byMe].filter((t) => !t.is_done && new Date(t.updated_at).getTime() <= cut)
        .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)).slice(0, 30).map((t) => insights.slimTodo(t));
    }
    case 'team_workload': {
      const { team } = insights.classify(await insights.loadRows(actor), actor.id);
      return insights.workload(team, todayInAppZone(), actor.id);
    }
    case 'progress_report': return insights.buildReport(await insights.loadRows(actor), actor, args.period === 'week' ? 'week' : 'day');
    default: return { error: 'Unknown tool' };
  }
}

/** A plain sentence for a proposed change, so the person can check it before saying yes. */
async function describe(actor, name, a) {
  const title = async (id) => { const t = await getTodoFor(id, actor.id, actor); return t ? `"${t.title}"` : `to-do #${id}`; };
  const fmt = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'no date');
  switch (name) {
    case 'create_todo': return `Create "${str(a.title)}"${a.assignee_username ? ` for @${str(a.assignee_username, 40)}` : ''}${a.due_date ? `, due ${fmt(a.due_date)}` : ''}${(a.steps || []).length ? ` with ${a.steps.length} steps` : ''}`;
    case 'reschedule_todo': return `Move ${await title(a.id)} to ${fmt(a.due_date)}`;
    case 'complete_todo': return `Mark ${await title(a.id)} as done`;
    case 'assign_todo': return `Give ${await title(a.id)} to @${str(a.username, 40)}`;
    case 'add_comment': return `Comment on ${await title(a.id)}: "${str(a.text, 120)}"`;
    case 'add_steps': return `Add ${(a.steps || []).length} steps to ${await title(a.id)}: ${(a.steps || []).slice(0, 6).map((s) => str(s, 60)).join('; ')}`;
    case 'set_priority': return `Set ${await title(a.id)} to priority ${parseInt(a.priority, 10) || '?'}`;
    default: return name;
  }
}

function systemPrompt(actor) {
  const today = todayInAppZone();
  const weekday = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  return `You are the TaskHub assistant, a chief of staff for ${actor.name}. Today is ${weekday} ${today} (time zone ${APP_TIMEZONE}). `
    + 'You see only what this person can see. Use the read tools to look things up; never guess a to-do id, always search first. '
    + 'You cannot change anything yourself: to create, move, complete, assign, comment or add steps, call the matching tool, which only PROPOSES the change for the person to confirm. '
    + 'For several changes, call the tool several times. Reply in short plain sentences with no markdown, no lists of ids, as if speaking aloud. '
    + 'When you proposed changes, say briefly what you propose and that it needs their OK. If something is not possible or not allowed, say so plainly. '
    + 'Dates are YYYY-MM-DD when calling tools; turn "tomorrow" or "next Friday" into real dates from today. '
    + 'For "what should I do", pending, overdue, workload or progress questions use overview, assigned_work, stale_todos, team_workload or progress_report. '
    + 'Base every statement on tool results; never invent tasks, numbers or people. When creating a to-do from a request like "remind me to X by Friday", '
    + 'pick a clear title, the real date and a sensible priority (1 urgent, 2 high, 3 normal, 4 low), and propose it with create_todo. '
    + 'To break a big task into smaller ones, search for it, then propose add_steps with 3 to 8 concrete steps.';
}

// POST /api/assistant/chat — { messages: [{ role: 'user' | 'assistant', content }] } -> { reply, proposals: [{ tool, args, summary }] }
router.post('/chat', authenticate, async (req, res, next) => {
  try {
    if (!configured()) return res.status(503).json({ error: 'The assistant is not switched on yet. Ask the owner to add the OpenAI key.' });
    const actor = await loadActor(req.user.id);
    const history = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-14)
      .filter((m) => ['user', 'assistant'].includes(m.role) && m.content)
      .map((m) => ({ role: m.role, content: str(m.content, 3000) }));
    if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'Say something first' });

    const messages = [{ role: 'system', content: systemPrompt(actor) }, ...history];
    const proposals = [];
    let reply = '';
    for (let turn = 0; turn < 6; turn += 1) {
      const msg = await chatTools({ messages, tools: [...READ_TOOLS, ...WRITE_TOOLS] });
      if (!msg.tool_calls || !msg.tool_calls.length) { reply = String(msg.content || '').trim(); break; }
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* the model sent nothing usable */ }
        let result;
        try {
          if (WRITE_NAMES.has(call.function.name)) {
            proposals.push({ tool: call.function.name, args, summary: await describe(actor, call.function.name, args) });
            result = { status: 'proposed, waiting for the person to confirm' };
          } else {
            result = await runRead(actor, call.function.name, args);
          }
        } catch (err) {
          result = { error: err.message };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
      }
    }
    if (!reply) reply = proposals.length ? 'Here is what I would do. Please check it.' : 'I could not work that out. Try asking another way.';
    logActivity(actor.id, 'question', history[history.length - 1].content);
    res.json({ reply, proposals });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---- carrying out confirmed proposals -----------------------------------------------------------------

async function userByName(username) {
  const u = (await db.query(`SELECT id, name FROM users WHERE status <> 'inactive' AND LOWER(username) = LOWER($1)`, [str(username, 60).replace(/^@/, '')])).rows[0];
  if (!u) throw new Error(`I could not find @${username}`);
  return u;
}

async function carryOut(actor, tool, a) {
  const uid = actor.id;
  switch (tool) {
    case 'create_todo': {
      const person = a.assignee_username ? await userByName(a.assignee_username) : null;
      const steps = (Array.isArray(a.steps) ? a.steps : []).map((s) => str(s, 300)).filter(Boolean).slice(0, 15);
      const body = {
        title: str(a.title, 500),
        due_date: isDate(a.due_date) ? a.due_date : undefined,
        due_time: /^\d{2}:\d{2}$/.test(a.due_time || '') ? a.due_time : undefined,
        priority: [1, 2, 3, 4].includes(Number(a.priority)) ? Number(a.priority) : undefined,
        delegate_to: person ? person.id : undefined,
        notes: person && steps.length ? steps.map((s) => `- ${s}`).join('\n') : undefined,
      };
      // No duplicates: an open to-do of mine with the same title is reused instead of made again.
      const same = (await db.query(
        `SELECT id FROM todos WHERE created_by = $1 AND is_done = FALSE AND LOWER(TRIM(title)) = LOWER(TRIM($2)) AND parent_id IS NULL LIMIT 1`,
        [uid, body.title]
      )).rows[0];
      if (same) return `"${body.title}" is already on your list, so I did not add it again`;
      const out = await mustCall(uid, 'POST', '/todos', body);
      if (out.todo && steps.length) for (const s of steps) await mustCall(uid, 'POST', '/todos', { title: s, parent_id: out.todo.id });
      return `Created "${body.title}"${person ? ` for ${person.name}` : ''}`;
    }
    case 'reschedule_todo':
      if (!isDate(a.due_date)) throw new Error('That date is not valid');
      await mustCall(uid, 'PUT', `/todos/${parseInt(a.id, 10)}`, { due_date: a.due_date, due_time: /^\d{2}:\d{2}$/.test(a.due_time || '') ? a.due_time : undefined });
      return `Moved to ${a.due_date}`;
    case 'complete_todo': {
      const t = await getTodoFor(a.id, uid, actor);
      if (!t) throw new Error('I could not find that to-do');
      if (t.is_done) return `"${t.title}" was already done`;
      await mustCall(uid, 'POST', `/todos/${t.id}/toggle`);
      return `Done: "${t.title}"`;
    }
    case 'assign_todo': {
      const person = await userByName(a.username);
      await mustCall(uid, 'POST', `/todos/${parseInt(a.id, 10)}/assign`, { user_id: person.id });
      return `Given to ${person.name}`;
    }
    case 'add_comment':
      await mustCall(uid, 'POST', `/todos/${parseInt(a.id, 10)}/comments`, { body: str(a.text, 2000) });
      return 'Comment added';
    case 'add_steps': {
      const steps = (Array.isArray(a.steps) ? a.steps : []).map((s) => str(s, 300)).filter(Boolean).slice(0, 15);
      for (const s of steps) await mustCall(uid, 'POST', '/todos', { title: s, parent_id: parseInt(a.id, 10) });
      return `${steps.length} steps added`;
    }
    case 'set_priority': {
      const p = parseInt(a.priority, 10);
      if (![1, 2, 3, 4].includes(p)) throw new Error('Priority must be 1 to 4');
      const t = await getTodoFor(a.id, uid, actor);
      if (!t) throw new Error('I could not find that to-do');
      await mustCall(uid, 'PUT', `/todos/${t.id}`, { priority: p });
      return `"${t.title}" is now priority ${p}`;
    }
    default:
      throw new Error('Unknown action');
  }
}

// POST /api/assistant/execute — { actions: [{ tool, args }] } the person said yes. Each is made as them.
router.post('/execute', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const actions = (Array.isArray(req.body.actions) ? req.body.actions : []).slice(0, 25);
    const results = [];
    for (const act of actions) {
      if (!WRITE_NAMES.has(act.tool)) { results.push({ ok: false, message: 'Unknown action' }); continue; }
      try {
        const message = await carryOut(actor, act.tool, act.args || {});
        results.push({ ok: true, message });
        logActivity(actor.id, 'action', message);
      } catch (err) {
        results.push({ ok: false, message: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// ---- the AI Assistant dashboard ---------------------------------------------------------------------------

// GET /api/assistant/overview — counts, lists and data-based insights (no AI call, so it is fast and always works).
router.get('/overview', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    res.json({ ...insights.buildOverview(await insights.loadRows(actor), actor), ai: configured(), name: actor.name });
  } catch (err) {
    next(err);
  }
});

// GET /api/assistant/report?period=day|week — the numbers of the daily or weekly report.
router.get('/report', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    res.json(insights.buildReport(await insights.loadRows(actor), actor, req.query.period === 'week' ? 'week' : 'day'));
  } catch (err) {
    next(err);
  }
});

// GET /api/assistant/activity — the person's recent assistant activity.
router.get('/activity', authenticate, async (req, res, next) => {
  try {
    const rows = (await db.query(
      'SELECT id, kind, summary, created_at FROM assistant_activity WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15', [req.user.id]
    ).catch((err) => { if (err.code === '42P01') return { rows: [] }; throw err; })).rows;
    res.json({ activity: rows });
  } catch (err) {
    next(err);
  }
});

// AI answers are kept a while per person and per state of their to-dos, and one request at a time is made for the
// same thing: opening the dashboard twice, or two tabs, never pays for the same answer twice.
const aiCache = new Map(); // key -> { at, value }
const aiInflight = new Map(); // key -> Promise
const AI_TTL_MS = 20 * 60 * 1000;
function cachedAi(key, force, make) {
  const hit = aiCache.get(key);
  if (!force && hit && Date.now() - hit.at < AI_TTL_MS) return Promise.resolve({ ...hit.value, cached: true });
  if (aiInflight.has(key)) return aiInflight.get(key);
  const p = make()
    .then((value) => {
      aiCache.set(key, { at: Date.now(), value });
      if (aiCache.size > 500) aiCache.delete(aiCache.keys().next().value);
      return value;
    })
    .finally(() => aiInflight.delete(key));
  aiInflight.set(key, p);
  return p;
}
/** Changes whenever one of the person's to-dos changes, so a cached answer is never about old data. */
const stateKey = (rows) => rows.reduce((h, t) => (h * 31 + t.id + new Date(t.updated_at).getTime() % 100000) % 2147483647, rows.length);

const SUGGEST_SYSTEM = `You are a productivity manager inside a to-do app. You get the person's real open to-dos as JSON
(id, title, priority 1 highest..4 lowest, status, due_date, deadline_date, progress %, steps, updated_days_ago, assignee, created_by,
role: "mine" = the person does it, "given_out" = the person gave it to someone else and only follows up).
Only "mine" to-dos go in do_today, most_important, can_postpone, before_deadline, running_long and priority_changes;
"given_out" to-dos may only appear in needs_attention (as a follow-up with the assignee).
Answer with a JSON object with exactly these keys:
"headline": one or two sentences, e.g. "You have 5 to-dos due today. Start with X because its deadline is closest.",
"do_today": [{"id", "why"}] up to 5, in the order to do them,
"most_important": [{"id", "why"}] up to 3,
"needs_attention": [{"id", "why"}] up to 4 (late, stuck, not updated, close deadline),
"can_postpone": [{"id", "why"}] up to 3 (low priority, far date, nothing depends on it),
"before_deadline": [{"id", "why"}] up to 4 (must be finished before an upcoming deadline),
"running_long": [{"id", "why"}] up to 3 (in progress a long time or little progress),
"priority_changes": [{"id", "priority", "why"}] up to 4, only when the current priority clearly does not fit,
"organize": [string] up to 3 short tips on organising this workload,
"coach": [string] up to 3 short, personal productivity tips based on these to-dos.
Use ONLY ids from the input. Never invent to-dos, people, dates or numbers. Keep every "why" under 20 words. Plain text, no markdown.
Empty arrays are fine when nothing fits.`;

// POST /api/assistant/suggestions — { force? } AI suggestions on the person's real to-dos, checked against them.
router.post('/suggestions', authenticate, async (req, res, next) => {
  try {
    if (!configured()) return res.status(503).json({ error: 'AI suggestions are not switched on yet. Ask the owner to add the OpenAI key.' });
    const actor = await loadActor(req.user.id);
    const rows = await insights.loadRows(actor);
    const { mine, byMe } = insights.classify(rows, actor.id);
    const open = [...mine, ...byMe].filter((t) => !t.is_done);
    if (!open.length) return res.json({ headline: 'Nothing is open on your list, so there is nothing to suggest right now.', empty: true });
    const pick = open.sort((a, b) => (insights.keyDate(a) || '9999').localeCompare(insights.keyDate(b) || '9999') || a.priority - b.priority).slice(0, 60);
    const byId = new Map(pick.map((t) => [t.id, t]));
    const givenOut = new Set(byMe.map((t) => t.id)); // someone else does these: only "needs attention" (follow up)
    const result = await cachedAi(`sug:${actor.id}:${stateKey(rows)}`, !!req.body?.force, async () => {
      const today = todayInAppZone();
      const raw = await chatJSON({
        system: SUGGEST_SYSTEM,
        user: JSON.stringify({ today, person: actor.name, todos: pick.map((t) => ({ ...insights.slimTodo(t), role: givenOut.has(t.id) ? 'given_out' : 'mine' })) }),
        maxTokens: 1600,
      });
      // Keep only what refers to real to-dos of this person, with the title from the database (never the model's).
      const items = (list, n, followUp = false) => (Array.isArray(list) ? list : [])
        .filter((x) => x && byId.has(Number(x.id)) && (followUp || !givenOut.has(Number(x.id))))
        .slice(0, n)
        .map((x) => ({ id: Number(x.id), title: byId.get(Number(x.id)).title, why: str(x.why, 200) }));
      const tips = (list) => (Array.isArray(list) ? list : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 3);
      const out = {
        headline: str(raw.headline, 400),
        do_today: items(raw.do_today, 5),
        most_important: items(raw.most_important, 3),
        needs_attention: items(raw.needs_attention, 4, true),
        can_postpone: items(raw.can_postpone, 3),
        before_deadline: items(raw.before_deadline, 4),
        running_long: items(raw.running_long, 3),
        priority_changes: (Array.isArray(raw.priority_changes) ? raw.priority_changes : [])
          .filter((x) => x && byId.has(Number(x.id)) && !givenOut.has(Number(x.id)) && [1, 2, 3, 4].includes(Number(x.priority)) && Number(x.priority) !== byId.get(Number(x.id)).priority)
          .slice(0, 4)
          .map((x) => ({ id: Number(x.id), title: byId.get(Number(x.id)).title, from: byId.get(Number(x.id)).priority, priority: Number(x.priority), why: str(x.why, 200) })),
        organize: tips(raw.organize),
        coach: tips(raw.coach),
        generated_at: new Date().toISOString(),
      };
      logActivity(actor.id, 'suggestions', out.headline || 'Suggestions made');
      return out;
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/assistant/report/summary — { period, force? } a short written summary of the report's real numbers.
router.post('/report/summary', authenticate, async (req, res, next) => {
  try {
    if (!configured()) return res.status(503).json({ error: 'AI summaries are not switched on yet. Ask the owner to add the OpenAI key.' });
    const actor = await loadActor(req.user.id);
    const period = req.body?.period === 'week' ? 'week' : 'day';
    const rows = await insights.loadRows(actor);
    const report = insights.buildReport(rows, actor, period);
    const result = await cachedAi(`rep:${period}:${actor.id}:${stateKey(rows)}`, !!req.body?.force, async () => {
      const raw = await chatJSON({
        system: `You write a short ${period === 'week' ? 'weekly' : 'daily'} progress report for one person from the JSON you get (their real to-dos).
Answer with JSON: {"summary": 2-3 sentences, "highlights": [up to 4 short strings: accomplishments or trends], "recommendations": [up to 4 short strings for ${period === 'week' ? 'next week' : 'tomorrow'}]}.
Use only what is in the data; quote to-do titles exactly; never invent numbers. Plain text, no markdown.`,
        user: JSON.stringify(report),
        maxTokens: 700,
      });
      const list = (l) => (Array.isArray(l) ? l : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 4);
      const out = { summary: str(raw.summary, 600), highlights: list(raw.highlights), recommendations: list(raw.recommendations), generated_at: new Date().toISOString() };
      logActivity(actor.id, 'report', `${period === 'week' ? 'Weekly' : 'Daily'} report: ${out.summary}`);
      return out;
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
