/**
 * What each automation action does in the world. Anything that changes a to-do, a chat or a person goes
 * through the app's own API as the person who owns the automation (see internalApi.js), so the same
 * permissions and notifications apply as if they had done it by hand. Counted limits stop a runaway task.
 */
const http = require('http');
const https = require('https');
const db = require('../../db');
const { getIO, notify } = require('../../utils/notify');
const { todayInAppZone } = require('../../utils/recurrence');
const { listTodos, getTodoFor } = require('../todoQueries');
const { checkUrl } = require('../../utils/automation/netguard');
const { mustCall } = require('./internalApi');
const { asText } = require('../../utils/automation/expr');

const BUDGET = { messages: 20, http: 10, changes: 50 };
const MAX_BODY = 100 * 1024;

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

function spend(ctx, kind, label) {
  ctx.spent = ctx.spent || { messages: 0, http: 0, changes: 0 };
  ctx.spent[kind] += 1;
  if (ctx.spent[kind] > BUDGET[kind]) throw new Error(`This run tried to ${label} too many times and was stopped`);
}

async function todoOf(ctx, value) {
  const id = parseInt(value, 10);
  if (!id) throw new Error('No to-do to work on. This task was not started by a to-do, so say which one');
  const todo = await getTodoFor(id, ctx.owner.id, ctx.owner);
  if (!todo) throw new Error(`To-do ${id} was not found, or you cannot see it`);
  return todo;
}

function dueFrom(p) {
  const today = todayInAppZone();
  if (p.when === 'today') return today;
  if (p.when === 'tomorrow') return addDays(today, 1);
  if (p.when === 'days') {
    const n = Math.max(0, Math.min(3650, parseInt(p.days, 10) || 0));
    return addDays(today, n);
  }
  return null;
}

/** Tell the person's open app to do something. Returns false if the app is not open anywhere. */
function effect(ownerId, payload) {
  const io = getIO();
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${ownerId}`);
  if (!room || room.size === 0) return false;
  io.to(`user:${ownerId}`).emit('automation:effect', payload);
  return true;
}

function parseHeaders(text) {
  const out = {};
  for (const line of String(text || '').split('\n').slice(0, 20)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    if (!/^[A-Za-z0-9-]{1,40}$/.test(name)) continue;
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) continue;
    out[name] = line.slice(i + 1).trim().slice(0, 500);
  }
  return out;
}

/** One request to a public address, pinned to the address that was checked. */
function request({ url, address, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: { 'User-Agent': 'TaskHub-Automation/1.0', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      lookup: (host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]) : cb(null, address, address.includes(':') ? 6 : 4)),
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c); else req.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('close', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('The website took too long to answer')));
    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

const FIND = {
  overdue: 't.due_date < $5::date',
  today: 't.due_date = $5::date',
  week: 't.due_date >= $5::date AND t.due_date <= ($5::date + 7)',
  inbox: 'tm.list_id IS NULL AND t.parent_id IS NULL',
  urgent: 't.priority = 1',
  open: 'TRUE',
};

const handlers = {
  async create_todo(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const body = { title: p.title, notes: p.notes || '', priority: parseInt(p.priority, 10) || 4 };
    const due = dueFrom(p);
    if (due) body.due_date = due;
    if (due && p.time) body.due_time = p.time;
    if (p.labels) body.labels = String(p.labels).split(',').map((s) => s.trim()).filter(Boolean);
    const businessId = parseInt(p.business_id, 10);
    const person = parseInt(p.assign_to, 10);
    if (businessId) {
      body.business_id = businessId;
      if (person) body.assign_to = person;
    } else if (person && person !== ctx.owner.id) body.delegate_to = person;
    const out = await mustCall(ctx.owner.id, 'POST', '/todos', body);
    const id = (out.todo && out.todo.id) || null;
    if (id) ctx.setVar('new_todo_id', id);
    return { note: `added "${String(p.title).slice(0, 50)}"` };
  },
  async complete_todo(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    if (todo.is_done) return { note: 'already finished' };
    await mustCall(ctx.owner.id, 'POST', `/todos/${todo.id}/toggle`, {});
    return { note: `finished "${todo.title.slice(0, 50)}"` };
  },
  async reopen_todo(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    if (!todo.is_done) return { note: 'already open' };
    await mustCall(ctx.owner.id, 'POST', `/todos/${todo.id}/toggle`, {});
    return { note: `reopened "${todo.title.slice(0, 50)}"` };
  },
  async rename_todo(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    await mustCall(ctx.owner.id, 'PUT', `/todos/${todo.id}`, { title: p.title });
    return { note: 'renamed' };
  },
  async set_priority(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    await mustCall(ctx.owner.id, 'PUT', `/todos/${todo.id}`, { priority: parseInt(p.priority, 10) || 4 });
    return { note: `priority ${p.priority}` };
  },
  async add_label(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    const labels = [...new Set([...(todo.labels || []), String(p.label).trim()])].filter(Boolean);
    await mustCall(ctx.owner.id, 'PUT', `/todos/${todo.id}`, { labels });
    return { note: `label ${p.label}` };
  },
  async remove_label(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    const drop = String(p.label).trim().toLowerCase().replace(/^[#+@]+/, '');
    await mustCall(ctx.owner.id, 'PUT', `/todos/${todo.id}`, { labels: (todo.labels || []).filter((l) => l !== drop) });
    return { note: `removed ${p.label}` };
  },
  async set_due(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    await mustCall(ctx.owner.id, 'PUT', `/todos/${todo.id}`, { due_date: p.when === 'clear' ? null : dueFrom(p) });
    return { note: p.when === 'clear' ? 'no date' : `due ${dueFrom(p)}` };
  },
  async set_status(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    await mustCall(ctx.owner.id, 'POST', `/todos/${todo.id}/status`, { status: p.status });
    return { note: p.status };
  },
  async assign_todo(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    await mustCall(ctx.owner.id, 'POST', `/todos/${todo.id}/assign`, { user_id: parseInt(p.person, 10) });
    return { note: 'assigned' };
  },
  async add_comment(p, ctx) {
    spend(ctx, 'changes', 'change to-dos');
    const todo = await todoOf(ctx, p.todo);
    await mustCall(ctx.owner.id, 'POST', `/todos/${todo.id}/comments`, { body: p.text });
    return { note: 'commented' };
  },
  async find_todos(p, ctx) {
    const today = todayInAppZone();
    const where = [`t.is_done = FALSE`, `t.review_state = 'accepted'`, `(t.business_id IS NULL OR t.assignee_id = $1)`, FIND[p.which] || FIND.open, '$5::date IS NOT NULL'];
    const params = [today];
    if (p.label) { params.push(String(p.label).toLowerCase().replace(/^[#+@]+/, '')); where.push(`$${params.length + 4} = ANY(t.labels)`); }
    if (parseInt(p.business_id, 10)) { params.push(parseInt(p.business_id, 10)); where.push(`t.business_id = $${params.length + 4}`); }
    // The viewer takes $1..$4; the date is $5, then the label and business.
    const rows = await listTodos(ctx.owner.id, {
      where: where.join(' AND '),
      params,
      tail: 'ORDER BY t.due_date NULLS LAST, t.priority, t.id LIMIT 50',
      actor: ctx.owner,
    });
    const name = String(p.into || 'found').replace(/^%/, '').replace(/[^A-Za-z0-9_]/g, '') || 'found';
    ctx.setVar(name, rows.map((r) => r.title));
    ctx.setVar(`${name}_ids`, rows.map((r) => r.id));
    ctx.setVar(`${name}_count`, rows.length);
    return { note: `${rows.length} found` };
  },
  async notify_me(p, ctx) {
    spend(ctx, 'messages', 'send messages');
    await notify([ctx.owner.id], { type: 'automation', title: p.title || 'TaskHub', body: p.message || '', data: { type: 'automation' } });
    return { note: 'sent to you' };
  },
  async notify_user(p, ctx) {
    spend(ctx, 'messages', 'send messages');
    const id = parseInt(p.person, 10);
    const person = id ? (await db.query(`SELECT id, name FROM users WHERE id = $1 AND status != 'inactive'`, [id])).rows[0] : null;
    if (!person) throw new Error('That person was not found');
    await notify([person.id], {
      type: 'automation', title: p.title || 'TaskHub',
      body: `${p.message || ''}${p.message ? ' · ' : ''}sent by ${ctx.owner.name}'s automation`, data: { type: 'automation', from: ctx.owner.id },
    });
    return { note: `told ${person.name}` };
  },
  async send_chat(p, ctx) {
    spend(ctx, 'messages', 'send messages');
    const id = parseInt(p.person, 10);
    if (!id || id === ctx.owner.id) throw new Error('Choose someone else to message');
    const conv = await mustCall(ctx.owner.id, 'POST', '/chat/conversations', { type: 'direct', participantIds: [id] });
    const cid = conv.conversation && conv.conversation.id;
    if (!cid) throw new Error('The chat could not be opened');
    await mustCall(ctx.owner.id, 'POST', `/chat/conversations/${cid}/messages`, { body: p.text });
    return { note: 'message sent' };
  },
  async toast(p, ctx) {
    const shown = effect(ctx.owner.id, { kind: 'toast', message: p.message });
    return { note: shown ? 'shown' : 'app is closed' };
  },
  async alert(p, ctx) {
    const shown = effect(ctx.owner.id, { kind: 'alert', title: p.title, message: p.message });
    if (shown) return { note: 'shown' };
    spend(ctx, 'messages', 'send messages');
    await notify([ctx.owner.id], { type: 'automation', title: p.title || 'Heads up', body: p.message || '', data: { type: 'automation' } });
    return { note: 'app is closed, sent a push' };
  },
  async sound(p, ctx) { return { note: effect(ctx.owner.id, { kind: 'sound', sound: p.kind }) ? 'played' : 'app is closed' }; },
  async vibrate(p, ctx) { return { note: effect(ctx.owner.id, { kind: 'vibrate', ms: Math.min(2000, Number(p.ms) || 300) }) ? 'sent' : 'app is closed' }; },
  async speak(p, ctx) { return { note: effect(ctx.owner.id, { kind: 'speak', text: String(p.text).slice(0, 300) }) ? 'spoken' : 'app is closed' }; },
  async open_screen(p, ctx) { return { note: effect(ctx.owner.id, { kind: 'open', screen: p.screen }) ? 'opened' : 'app is closed' }; },
  async open_todo(p, ctx) {
    const todo = await todoOf(ctx, p.todo);
    return { note: effect(ctx.owner.id, { kind: 'open_todo', todoId: todo.id }) ? 'opened' : 'app is closed' };
  },
  async start_focus(p, ctx) {
    return { note: effect(ctx.owner.id, { kind: 'focus', minutes: Math.min(120, Number(p.minutes) || 25), todoId: parseInt(p.todo, 10) || null }) ? 'started' : 'app is closed' };
  },
  async http_request(p, ctx) {
    if (!ctx.owner.can('automation_web')) throw new Error('Calling web addresses is not switched on for you');
    spend(ctx, 'http', 'call web addresses');
    const method = ['GET', 'POST', 'PUT', 'DELETE'].includes(p.method) ? p.method : 'GET';
    const { url, address } = await checkUrl(p.url);
    const body = method === 'GET' || method === 'DELETE' ? undefined : String(p.body || '').slice(0, 20000);
    const headers = parseHeaders(p.headers);
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = body.trim().startsWith('{') || body.trim().startsWith('[') ? 'application/json' : 'text/plain';
    }
    const res = await request({ url, address, method, headers, body });
    const into = String(p.into || 'http_body').replace(/^%/, '').replace(/[^A-Za-z0-9_]/g, '') || 'http_body';
    ctx.setVar('http_status', res.status);
    ctx.setVar(into, res.body);
    try {
      const json = JSON.parse(res.body);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        for (const [k, v] of Object.entries(json).slice(0, 30)) {
          if (v === null || typeof v === 'object') continue;
          ctx.setVar(`${into}_${k.replace(/[^A-Za-z0-9_]/g, '_')}`, v);
        }
      }
    } catch { /* not JSON, the text is still in the variable */ }
    return { note: `${method} ${url.hostname} -> ${res.status}` };
  },
};

/** The `deps.exec` for the runner. */
async function exec(type, params, ctx) {
  const handler = handlers[type];
  if (!handler) throw new Error(`"${type}" cannot run yet`);
  return handler(params, ctx);
}

module.exports = { exec, effect, addDays, parseHeaders, FIND, asText };
