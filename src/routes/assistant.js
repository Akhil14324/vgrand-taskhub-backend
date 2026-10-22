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

// /api/assistant: a chief of staff you can talk to. It answers from the person's own view of the data and
// never changes anything on its own: changes come back as proposals the person confirms, and are then made
// through the app's normal API as that person, so every permission and notification rule applies.
const router = express.Router();

const str = (v, n = 300) => sanitizeText(String(v ?? ''), n) || '';
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
  fn('add_steps', 'Propose adding steps (sub-tasks) to a to-do.', { id: { type: 'integer' }, steps: { type: 'array', items: { type: 'string' } } }, ['id', 'steps']),
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
    case 'add_steps': return `Add ${(a.steps || []).length} steps to ${await title(a.id)}`;
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
    + 'Dates are YYYY-MM-DD when calling tools; turn "tomorrow" or "next Friday" into real dates from today.';
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
        results.push({ ok: true, message: await carryOut(actor, act.tool, act.args || {}) });
      } catch (err) {
        results.push({ ok: false, message: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
