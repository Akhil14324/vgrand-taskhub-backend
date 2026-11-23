const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor } = require('../utils/org');
const { listTodos } = require('../services/todoQueries');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');
const { chatTools, configured } = require('../utils/openai');
const { businessHealth } = require('../services/insights');
const { atRisk } = require('../services/risk');
const { callApi, mustCall } = require('../services/automation/internalApi');
const { chatJSON } = require('../utils/openai');
const rateLimit = require('express-rate-limit');
const insights = require('../services/assistantInsights');
const analytics = require('../services/assistantAnalytics');
const { validateAction, DANGEROUS, PRIORITY_LABEL } = require('../services/assistantActions');

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

// The chat is the costly call (up to six model turns each), so it is limited per person, not per address.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `assistant:${req.user && req.user.id}`,
  message: { error: 'You are asking quickly. Give the assistant a moment and try again.' },
});

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
  fn('assigned_work', 'To-dos assigned TO the person by others (to_me), assigned BY the person to others (by_me), or shared with the person and others without one owner (shared), with status, progress and last update.', {
    direction: { type: 'string', enum: ['to_me', 'by_me', 'shared'] },
    status: { type: 'string', enum: ['open', 'overdue', 'stale', 'done'] },
  }, ['direction']),
  fn('stale_todos', 'Open to-dos (the person\'s own and the ones they gave out) not updated for a number of days.', { days: { type: 'integer', description: 'default 3' } }),
  fn('team_workload', 'Open, overdue, due-this-week and stuck work per person the person can see, who is overloaded or light, and (when it is uneven) which to-dos could move from the busy to the light people. Use it to balance work.'),
  fn('progress_report', 'Daily, weekly or monthly report from the data: completed, pending, delayed, progress %, trend; weekly and monthly also have business progress, team progress, productivity observations and areas to improve. Use it for reports, "how is the team progressing" and end-of-day or end-of-week summaries.', { period: { type: 'string', enum: ['day', 'week', 'month'] } }, ['period']),
  fn('business_summary', 'Per business the person can see: open, overdue, stuck and unassigned work, what was finished lately, the share done, which business has the most pending work and the items that need attention. Use it for any question about how the businesses or a business are doing.', { period: { type: 'string', enum: ['week', 'month'], description: 'how far back finished work counts, default week' } }),
  fn('priority_suggestions', 'To-dos whose priority does not fit their dates or dependencies, with the priority they should probably have and why. Use it for "what should I prioritize" and to propose set_priority changes.'),
];

const WRITE_TOOLS = [
  fn('create_todo', 'Propose a new to-do, optionally for someone else, with a description and steps. Only fill what the person said or clearly implied; leave the rest out.', {
    title: { type: 'string' }, notes: { type: 'string', description: 'description, only if the person gave one' },
    assignee_username: { type: 'string', description: 'username or name of the person; the app finds the person' },
    due_date: { type: 'string', description: 'YYYY-MM-DD' },
    due_time: { type: 'string', description: 'HH:MM' }, priority: { type: 'integer', description: '1 highest to 4' },
    steps: { type: 'array', items: { type: 'string' } },
  }, ['title']),
  fn('reschedule_todo', 'Propose moving a to-do to another date.', { id: { type: 'integer' }, due_date: { type: 'string' }, due_time: { type: 'string' } }, ['id', 'due_date']),
  fn('complete_todo', 'Propose ticking a to-do as done.', { id: { type: 'integer' } }, ['id']),
  fn('assign_todo', 'Propose giving a to-do to someone.', { id: { type: 'integer' }, username: { type: 'string' } }, ['id', 'username']),
  fn('add_comment', 'Propose a comment on a to-do.', { id: { type: 'integer' }, text: { type: 'string' } }, ['id', 'text']),
  fn('add_steps', 'Propose adding steps (sub-tasks) to a to-do. Use it to break a big task into smaller ones.', { id: { type: 'integer' }, steps: { type: 'array', items: { type: 'string' } } }, ['id', 'steps']),
  fn('set_priority', 'Propose a new priority for a to-do (1 highest, 4 lowest).', { id: { type: 'integer' }, priority: { type: 'integer' } }, ['id', 'priority']),
  fn('delete_todo', 'Propose deleting a to-do. Use only when the person clearly asks to delete or remove it. The person must confirm, and the app decides what that means for them (delete it, leave it, or ask for deletion).', { id: { type: 'integer' } }, ['id']),
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

// ---- looking things up ----------------------------------------------------------------------------------

/** What one request needs from the database, loaded once however many tools ask for it. */
function makeCtx(actor) {
  const cache = new Map();
  return { rows: (days = 15) => { if (!cache.has(days)) cache.set(days, insights.loadRows(actor, days)); return cache.get(days); } };
}

/** The to-do with this id, but only if the person can see it (the app's own visibility); null otherwise. */
async function findVisible(actor, id) {
  const n = parseInt(id, 10);
  if (!n) return null;
  const rows = await listTodos(actor.id, { actor, where: 't.id = $5', params: [n], dumped: 'any', watching: 'any' });
  return rows[0] || null;
}

/** Rows of a month report need the month before for the trend; the others need two weeks. */
const daysFor = (period) => (period === 'month' ? 65 : 15);

async function runRead(actor, name, args, ctx) {
  switch (name) {
    case 'search_todos': return searchTodos(actor, args);
    case 'my_plan': return analytics.withoutGuessedTimes((await callApi(actor.id, 'GET', '/plan')).data, await ctx.rows());
    case 'at_risk': return atRisk(actor);
    case 'team_status': {
      if (!actor.can('insights')) return { error: 'Only leaders can see business status. Use business_summary for the businesses you belong to.' };
      const h = await businessHealth(actor, 7);
      return h.businesses.map((b) => ({ name: b.name, score: b.score, open: b.open, overdue: b.overdue, blocked: b.blocked, finished_this_week: b.completed, on_time_rate: b.on_time_rate }));
    }
    case 'find_person': return findUsers(args.name);
    case 'recall': return recall(actor, args.question);
    case 'overview': {
      const rows = await ctx.rows();
      const o = insights.buildOverview(rows, actor);
      return { today: o.today, counts: o.counts, due_today: o.due_today, overdue: o.overdue, upcoming: o.upcoming, stale: o.stale, waiting_on_others: o.waiting_on_others, conflicts: o.conflicts, insights: o.insights.map((i) => i.text) };
    }
    case 'assigned_work': {
      const rows = await ctx.rows();
      const { toMe, byMe, top } = insights.classify(rows, actor.id);
      const today = todayInAppZone();
      // Shared: several people are on it and nobody was singled out (the same rule as the app's Shared view).
      const shared = top.filter((t) => !t.business_id && (t.members || []).length > 1 && !(t.assignee_id && t.assignee_id !== t.created_by));
      let list = args.direction === 'by_me' ? byMe : args.direction === 'shared' ? shared : toMe;
      if (args.status === 'done') list = list.filter((t) => t.is_done);
      else {
        list = list.filter((t) => !t.is_done);
        if (args.status === 'overdue') list = list.filter((t) => insights.keyDate(t) && insights.keyDate(t) < today);
        if (args.status === 'stale') list = list.filter((t) => Date.now() - new Date(t.updated_at).getTime() >= insights.STALE_DAYS * 86400000);
      }
      return list.slice(0, 30).map((t) => (args.direction === 'shared'
        ? { ...insights.slimTodo(t), shared_with: (t.members || []).filter((m) => m.id !== actor.id).map((m) => m.name) }
        : insights.slimTodo(t)));
    }
    case 'stale_todos': {
      const days = Math.min(60, Math.max(1, parseInt(args.days, 10) || insights.STALE_DAYS));
      const { mine, byMe } = insights.classify(await ctx.rows(), actor.id);
      const cut = Date.now() - days * 86400000;
      return [...mine, ...byMe].filter((t) => !t.is_done && new Date(t.updated_at).getTime() <= cut)
        .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at)).slice(0, 30).map((t) => insights.slimTodo(t));
    }
    case 'team_workload': {
      const { team } = insights.classify(await ctx.rows(), actor.id);
      const wl = insights.workload(team, todayInAppZone(), actor.id);
      return { ...wl, moves: analytics.balanceMoves(team, wl) };
    }
    case 'progress_report': {
      const period = ['week', 'month'].includes(args.period) ? args.period : 'day';
      return analytics.fullReport(await ctx.rows(daysFor(period)), actor, period);
    }
    case 'business_summary': {
      const month = args.period === 'month';
      return analytics.businessSummary(await ctx.rows(month ? 35 : 15), todayInAppZone(), month ? 30 : 7);
    }
    case 'priority_suggestions': return analytics.prioritySuggestions(await ctx.rows(), actor);
    default: return { error: 'Unknown tool' };
  }
}

// ---- proposing changes ------------------------------------------------------------------------------------

/** One real colleague from a username or a name, or an Error that says who could not be found or which of several. */
async function resolvePerson(name) {
  const q = str(name, 60).replace(/^@/, '');
  const exact = (await db.query(`SELECT id, name, username FROM users WHERE status <> 'inactive' AND LOWER(username) = LOWER($1)`, [q])).rows[0];
  if (exact) return exact;
  const found = await findUsers(q);
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`I could not find anyone called "${q}"`);
  throw new Error(`"${q}" could mean ${found.map((u) => `${u.name} (@${u.username})`).join(', ')}. Ask the person which one.`);
}

/** What deleting means for this person: really delete, leave someone else's to-do, or ask for a business task to be deleted. */
function deleteMode(actor, t) {
  const perm = t.permissions || {};
  if (t.business_id) {
    if (perm.can_delete) return 'delete';
    if (perm.can_request_delete) return 'request';
    if (t.pending_delete_request_id) throw new Error('A request to delete this is already waiting for approval');
    throw new Error('You cannot delete this, and you cannot ask for it to be deleted');
  }
  return t.created_by === actor.id ? 'delete' : 'leave';
}

const MAX_PROPOSALS = 15; // changes in one answer
const MAX_DELETES = 5; // and deletions among them

/**
 * Checks a proposed change and describes it in plain words, so the person can check it before saying yes.
 * Returns { args (cleaned), summary, preview?, note?, danger? } or throws an Error with a readable message that is
 * given back to the model so it can correct itself. Nothing is changed here.
 */
async function propose(actor, tool, rawArgs) {
  const args = validateAction(tool, rawArgs);
  const need = async (id) => {
    const t = await findVisible(actor, id);
    if (!t) throw new Error(`I could not find to-do #${id}. Search for it first.`);
    return t;
  };
  const fmt = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'no date');
  switch (tool) {
    case 'create_todo': {
      const person = args.assignee_username ? await resolvePerson(args.assignee_username) : null;
      if (person) args.assignee_username = person.username; // the exact person, so carrying it out cannot pick someone else
      const due = args.due_date ? `${fmt(args.due_date)}${args.due_time ? ` at ${args.due_time}` : ''}` : null;
      return {
        args,
        summary: `Create "${args.title}"${person ? ` for ${person.name}` : ''}${due ? `, due ${due}` : ''}${args.steps.length ? ` with ${args.steps.length} step${args.steps.length === 1 ? '' : 's'}` : ''}`,
        preview: { title: args.title, notes: args.notes || null, due, assignee: person ? person.name : null, priority: args.priority ? `${args.priority} · ${PRIORITY_LABEL[args.priority]}` : null, steps: args.steps },
        note: person && person.id !== actor.id ? `${person.name} will be told they were given this.` : undefined,
      };
    }
    case 'reschedule_todo': {
      const t = await need(args.id);
      return { args, summary: `Move "${t.title}" to ${fmt(args.due_date)}${args.due_time ? ` at ${args.due_time}` : ''}` };
    }
    case 'complete_todo': {
      const t = await need(args.id);
      if (t.is_done) throw new Error(`"${t.title}" is already done`);
      return { args, summary: `Mark "${t.title}" as done` };
    }
    case 'assign_todo': {
      const t = await need(args.id);
      const person = await resolvePerson(args.username);
      args.username = person.username;
      return { args, summary: `Give "${t.title}" to ${person.name}`, note: 'This changes who is responsible, and they are told.' };
    }
    case 'add_comment': {
      const t = await need(args.id);
      return { args, summary: `Comment on "${t.title}": "${args.text.slice(0, 120)}"` };
    }
    case 'add_steps': {
      const t = await need(args.id);
      return { args, summary: `Add ${args.steps.length} step${args.steps.length === 1 ? '' : 's'} to "${t.title}"`, preview: { title: t.title, steps: args.steps } };
    }
    case 'set_priority': {
      const t = await need(args.id);
      if (t.priority === args.priority) throw new Error(`"${t.title}" already has priority ${args.priority}`);
      return { args, summary: `Change "${t.title}" from priority ${t.priority} to ${args.priority} (${PRIORITY_LABEL[args.priority]})` };
    }
    case 'delete_todo': {
      const t = await need(args.id);
      const mode = deleteMode(actor, t);
      if (mode === 'request') return { args, kind: 'request', summary: `Ask for "${t.title}" to be deleted`, note: 'A senior person has to approve it before it goes.' };
      if (mode === 'leave') return { args, kind: 'leave', summary: `Remove yourself from "${t.title}"`, note: 'It belongs to someone else, so it stays for them.' };
      return { args, kind: 'delete', danger: true, summary: `Delete "${t.title}"`, note: 'This cannot be undone.' };
    }
    default:
      throw new Error('That is not something the assistant can do');
  }
}

function systemPrompt(actor) {
  const today = todayInAppZone();
  const weekday = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  return `You are the TaskHub assistant, the chief of staff for ${actor.name}. Today is ${weekday} ${today} (time zone ${APP_TIMEZONE}). `
    + 'You see only what this person can see and talk about nothing else. Base every statement on tool results: never invent to-dos, people, dates, numbers or estimated times. If a tool returns nothing, say so plainly. '
    + 'Look things up with the read tools first; never guess a to-do id, search first. '
    + 'You cannot change anything yourself. To create, move, complete, delete, assign, comment, set a priority or add steps, call the matching tool, which only PROPOSES the change: the person confirms it in the app. '
    + 'For several changes call the tool several times. When you proposed changes, say briefly what you propose and that it needs their OK. If something is not possible or not allowed, say so plainly. '
    + 'Delete only when the person clearly asks to delete or remove something. '
    + 'Tools: overview (my numbers, what to do today, pending, overdue, upcoming), my_plan (the plan for today), assigned_work (to_me, by_me, shared), stale_todos, '
    + 'team_workload (also for balancing work), progress_report (day, week or month reports and summaries), business_summary (how the businesses are doing), at_risk (likely to miss their dates), '
    + 'priority_suggestions (what to prioritize), recall (what was decided), find_person. '
    + 'For a plan: greet the person by first name, then give 3 to 6 numbered lines, each a real to-do with one short reason taken from the data (overdue, due today, high priority, in progress, others wait for it). Quote a time or a length only when the tool gives one. '
    + 'For a report or an end-of-day summary: the real numbers first, then what went well, what needs attention and 2 to 4 recommendations for what comes next. '
    + 'Reply in plain text, no markdown symbols (no asterisks, no # headings). Short numbered lines are fine for plans and lists, otherwise short sentences. '
    + 'Dates are YYYY-MM-DD when calling tools; turn "tomorrow" or "next Friday" into real dates from today. '
    + 'To create a to-do from a request like "create a task to finish the frontend by Friday and assign it to Akhil": a clear title, the real date, the person (the name is enough), a priority only when it was said or clearly implied, a description only when one was given; propose it with create_todo. '
    + 'To break a big task into smaller ones: find it (or propose it with create_todo), then propose 3 to 8 concrete steps (add_steps, or the steps of create_todo). Do not invent dates for steps. '
    + 'To balance work, use team_workload and propose assign_todo only for the moves it lists. To advise on priorities, use priority_suggestions and propose set_priority. '
    + 'You are also a productivity coach: give practical, specific advice based on the data.';
}

// ---- conversation history (migration 073) ---------------------------------------------------------------------------

const MAX_CHATS = 50; // kept per person; the oldest go first

/** Stores one question and its answer. Never fails the answer: the history is a convenience. Returns { chat_id, message_id }. */
async function saveTurn(userId, chatId, question, reply, proposals) {
  try {
    let id = parseInt(chatId, 10) || null;
    if (id) {
      const own = await db.query('SELECT id FROM assistant_chats WHERE id = $1 AND user_id = $2', [id, userId]);
      if (!own.rows.length) id = null; // gone, or not theirs: start a new one
    }
    if (!id) {
      id = (await db.query('INSERT INTO assistant_chats (user_id, title) VALUES ($1, $2) RETURNING id', [userId, str(question, 60) || 'New chat'])).rows[0].id;
      await db.query(
        `DELETE FROM assistant_chats WHERE user_id = $1 AND id NOT IN
           (SELECT id FROM assistant_chats WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT ${MAX_CHATS})`, [userId]
      );
    }
    await db.query('INSERT INTO assistant_messages (chat_id, role, content) VALUES ($1, $2, $3)', [id, 'user', str(question, 6000)]);
    const answer = (await db.query(
      'INSERT INTO assistant_messages (chat_id, role, content, proposals) VALUES ($1, $2, $3, $4) RETURNING id',
      [id, 'assistant', str(reply, 6000), proposals.length ? JSON.stringify(proposals) : null]
    )).rows[0].id;
    await db.query('UPDATE assistant_chats SET updated_at = NOW() WHERE id = $1', [id]);
    return { chat_id: id, message_id: answer };
  } catch (err) {
    if (err.code !== '42P01') console.error('[assistant] saving the chat failed:', err.message);
    return { chat_id: null, message_id: null };
  }
}

// POST /api/assistant/chat — { messages: [{ role, content }], chat_id? } -> { reply, proposals, chat_id, message_id }
router.post('/chat', authenticate, chatLimiter, async (req, res, next) => {
  try {
    if (!configured()) return res.status(503).json({ error: 'The assistant is not switched on yet. Ask the owner to add the OpenAI key.' });
    const actor = await loadActor(req.user.id);
    const history = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-14)
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && m.content)
      .map((m) => ({ role: m.role, content: str(m.content, 3000) }));
    if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'Say something first' });

    const ctx = makeCtx(actor);
    const messages = [{ role: 'system', content: systemPrompt(actor) }, ...history];
    const proposals = [];
    const seen = new Set();
    let deletes = 0;
    let reply = '';
    const deadline = Date.now() + 75000; // the app waits 90 s: answer with what there is rather than hang
    for (let turn = 0; turn < 6; turn += 1) {
      if (Date.now() > deadline) { reply = 'That is taking too long to work out. Try a simpler question.'; break; }
      const msg = await chatTools({ messages, tools: [...READ_TOOLS, ...WRITE_TOOLS] });
      if (!msg.tool_calls || !msg.tool_calls.length) { reply = String(msg.content || '').trim(); break; }
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* the model sent nothing usable */ }
        let result;
        try {
          if (WRITE_NAMES.has(call.function.name)) {
            if (proposals.length >= MAX_PROPOSALS) throw new Error('That is too many changes in one go. Ask for fewer.');
            if (call.function.name === 'delete_todo' && deletes >= MAX_DELETES) throw new Error('That is too many deletions in one go. Ask for fewer.');
            const p = await propose(actor, call.function.name, args);
            const key = `${call.function.name}:${JSON.stringify(p.args)}`;
            if (seen.has(key)) { result = { status: 'already proposed' }; } else {
              seen.add(key);
              if (call.function.name === 'delete_todo') deletes += 1;
              proposals.push({ tool: call.function.name, ...p });
              result = { status: 'proposed, waiting for the person to confirm' };
            }
          } else {
            result = await runRead(actor, call.function.name, args, ctx);
          }
        } catch (err) {
          result = { error: err.message };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
      }
    }
    if (!reply) reply = proposals.length ? 'Here is what I would do. Please check it.' : 'I could not work that out. Try asking another way.';
    const question = history[history.length - 1].content;
    logActivity(actor.id, 'question', question);
    const saved = await saveTurn(actor.id, req.body.chat_id, question, reply, proposals);
    res.json({ reply, proposals, ...saved });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ---- carrying out confirmed proposals -----------------------------------------------------------------

async function carryOut(actor, tool, a) {
  const uid = actor.id;
  switch (tool) {
    case 'create_todo': {
      const person = a.assignee_username ? await resolvePerson(a.assignee_username) : null;
      const steps = a.steps.map((s) => str(s, 300)).filter(Boolean);
      const notes = [a.notes ? str(a.notes, 2000) : '', person && steps.length ? steps.map((s) => `- ${s}`).join('\n') : ''].filter(Boolean).join('\n\n');
      const body = {
        title: str(a.title, 500),
        due_date: a.due_date,
        due_time: a.due_time,
        priority: a.priority,
        delegate_to: person ? person.id : undefined,
        notes: notes || undefined,
      };
      // No duplicates: an open to-do of mine with the same title is reused instead of made again.
      const same = (await db.query(
        `SELECT id FROM todos WHERE created_by = $1 AND is_done = FALSE AND LOWER(TRIM(title)) = LOWER(TRIM($2)) AND parent_id IS NULL LIMIT 1`,
        [uid, body.title]
      )).rows[0];
      if (same) return `"${body.title}" is already on your list, so I did not add it again`;
      const out = await mustCall(uid, 'POST', '/todos', body);
      if (out.todo && steps.length && !person) for (const s of steps) await mustCall(uid, 'POST', '/todos', { title: s, parent_id: out.todo.id });
      return `Created "${body.title}"${person ? ` for ${person.name}` : ''}${steps.length ? ` with ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}`;
    }
    case 'reschedule_todo': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      await mustCall(uid, 'PUT', `/todos/${t.id}`, { due_date: a.due_date, due_time: a.due_time });
      return `Moved "${t.title}" to ${a.due_date}`;
    }
    case 'complete_todo': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      if (t.is_done) return `"${t.title}" was already done`;
      await mustCall(uid, 'POST', `/todos/${t.id}/toggle`);
      return `Done: "${t.title}"`;
    }
    case 'assign_todo': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      const person = await resolvePerson(a.username);
      await mustCall(uid, 'POST', `/todos/${t.id}/assign`, { user_id: person.id });
      return `Gave "${t.title}" to ${person.name}`;
    }
    case 'add_comment': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      await mustCall(uid, 'POST', `/todos/${t.id}/comments`, { body: str(a.text, 2000) });
      return 'Comment added';
    }
    case 'add_steps': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      for (const s of a.steps) await mustCall(uid, 'POST', '/todos', { title: str(s, 300), parent_id: t.id });
      return `${a.steps.length} step${a.steps.length === 1 ? '' : 's'} added to "${t.title}"`;
    }
    case 'set_priority': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      await mustCall(uid, 'PUT', `/todos/${t.id}`, { priority: a.priority });
      return `"${t.title}" is now priority ${a.priority}`;
    }
    case 'delete_todo': {
      const t = await findVisible(actor, a.id);
      if (!t) throw new Error('I could not find that to-do');
      const mode = deleteMode(actor, t); // decided again now, from what the person may do right now
      if (mode === 'request') {
        await mustCall(uid, 'POST', `/todos/${t.id}/request-delete`, { reason: 'Asked through the assistant' });
        return `Asked for "${t.title}" to be deleted. A senior person has to approve it.`;
      }
      await mustCall(uid, 'DELETE', `/todos/${t.id}`);
      return mode === 'leave' ? `You left "${t.title}". It stays for the others.` : `Deleted "${t.title}"`;
    }
    default:
      throw new Error('Unknown action');
  }
}

// POST /api/assistant/execute — { actions: [{ tool, args, confirmed? }], chat_id?, message_id? } the person said yes.
// Each is checked again and made as them, through the app's own API, so its permissions and notifications apply.
// Deleting also needs `confirmed: true` on its action: only the confirm button sends it.
router.post('/execute', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const actions = (Array.isArray(req.body.actions) ? req.body.actions : []).slice(0, 25);
    const results = [];
    for (const act of actions) {
      if (!act || !WRITE_NAMES.has(act.tool)) { results.push({ ok: false, message: 'Unknown action' }); continue; }
      if (DANGEROUS.has(act.tool) && act.confirmed !== true) { results.push({ ok: false, message: 'Deleting needs your explicit confirmation' }); continue; }
      try {
        const message = await carryOut(actor, act.tool, validateAction(act.tool, act.args));
        results.push({ ok: true, message });
        logActivity(actor.id, 'action', message);
      } catch (err) {
        results.push({ ok: false, message: err.message });
      }
    }
    const messageId = parseInt(req.body.message_id, 10);
    if (messageId) {
      await db.query(
        `UPDATE assistant_messages SET results = $1 WHERE id = $2 AND chat_id IN (SELECT id FROM assistant_chats WHERE user_id = $3)`,
        [JSON.stringify(results), messageId, actor.id]
      ).catch((err) => { if (err.code !== '42P01') console.error('[assistant] saving the result failed:', err.message); });
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// ---- the person's conversations ----------------------------------------------------------------------------------

const noTable = (err) => { if (err.code === '42P01') return { rows: [] }; throw err; }; // before migration 073 there are none

// GET /api/assistant/chats — the person's recent conversations, newest first.
router.get('/chats', authenticate, async (req, res, next) => {
  try {
    const rows = (await db.query(
      `SELECT c.id, c.title, c.updated_at, (SELECT COUNT(*)::int FROM assistant_messages m WHERE m.chat_id = c.id) AS messages
       FROM assistant_chats c WHERE c.user_id = $1 ORDER BY c.updated_at DESC, c.id DESC LIMIT ${MAX_CHATS}`, [req.user.id]
    ).catch(noTable)).rows;
    res.json({ chats: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/assistant/chats/:id — one conversation with its messages (only the person's own).
router.get('/chats/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const chat = (await db.query('SELECT id, title, updated_at FROM assistant_chats WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]).catch(noTable)).rows[0];
    if (!chat) return res.status(404).json({ error: 'That conversation was not found' });
    const messages = (await db.query(
      `SELECT id, role, content, proposals, results, is_error, created_at FROM assistant_messages WHERE chat_id = $1 ORDER BY id LIMIT 200`, [chat.id]
    )).rows;
    res.json({ chat, messages });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/assistant/chats/:id — removes a conversation and its messages.
router.delete('/chats/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const out = await db.query('DELETE FROM assistant_chats WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]).catch((err) => { if (err.code === '42P01') return { rowCount: 0 }; throw err; });
    if (!out.rowCount) return res.status(404).json({ error: 'That conversation was not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/assistant/messages/:id/decline — the person said "not now" to what a message proposed.
router.post('/messages/:id(\\d+)/decline', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query(
      `SELECT m.id, m.proposals FROM assistant_messages m JOIN assistant_chats c ON c.id = m.chat_id WHERE m.id = $1 AND c.user_id = $2`, [req.params.id, req.user.id]
    ).catch(noTable)).rows[0];
    if (!row) return res.status(404).json({ error: 'That message was not found' });
    const results = (row.proposals || []).map(() => ({ ok: false, message: 'Left as it was' }));
    await db.query('UPDATE assistant_messages SET results = $1 WHERE id = $2', [JSON.stringify(results), row.id]);
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
    const rows = await insights.loadRows(actor);
    const overview = insights.buildOverview(rows, actor);
    // The extras (business progress, priorities, balancing, recommendations, suggested questions) come from the same rows.
    res.json({ ...overview, ...analytics.overviewExtras(rows, actor, overview), ai: configured(), name: actor.name });
  } catch (err) {
    next(err);
  }
});

// GET /api/assistant/report?period=day|week|month — the numbers of the daily, weekly or monthly report.
router.get('/report', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const period = ['week', 'month'].includes(req.query.period) ? req.query.period : 'day';
    res.json(analytics.fullReport(await insights.loadRows(actor, daysFor(period)), actor, period));
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
    const period = ['week', 'month'].includes(req.body?.period) ? req.body.period : 'day';
    const rows = await insights.loadRows(actor, daysFor(period));
    const report = analytics.fullReport(rows, actor, period);
    const name = { day: 'daily', week: 'weekly', month: 'monthly' }[period];
    const next = { day: 'tomorrow', week: 'next week', month: 'next month' }[period];
    const result = await cachedAi(`rep:${period}:${actor.id}:${stateKey(rows)}`, !!req.body?.force, async () => {
      const raw = await chatJSON({
        system: `You write a short ${name} progress report for one person from the JSON you get (their real to-dos${period === 'day' ? '' : ', their businesses and their team'}).
Answer with JSON: {"summary": 2-3 sentences, "highlights": [up to 4 short strings: accomplishments or trends], "recommendations": [up to 4 short strings for ${next}]}.
Use only what is in the data; quote to-do titles exactly; never invent numbers. Plain text, no markdown.`,
        user: JSON.stringify(report),
        maxTokens: 700,
      });
      const list = (l) => (Array.isArray(l) ? l : []).map((s) => str(s, 240)).filter(Boolean).slice(0, 4);
      const out = { summary: str(raw.summary, 600), highlights: list(raw.highlights), recommendations: list(raw.recommendations), generated_at: new Date().toISOString() };
      logActivity(actor.id, 'report', `${name[0].toUpperCase()}${name.slice(1)} report: ${out.summary}`);
      return out;
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
