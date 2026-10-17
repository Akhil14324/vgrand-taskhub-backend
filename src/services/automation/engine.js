/**
 * The automation engine. It listens for things that happen (a to-do changes, a notification or chat
 * message arrives, the app opens), watches the clock and the state contexts every few seconds, and starts
 * the right task as the right person. Profiles are kept in memory for a few seconds so a busy server does
 * not query for them on every event.
 */
const db = require('../../db');
const { bus, als } = require('../../utils/automation/bus');
const { getIO } = require('../../utils/notify');
const { APP_TIMEZONE } = require('../../utils/recurrence');
const { loadActor } = require('../../utils/org');
const { audienceIds, getTodoFor } = require('../todoQueries');
const { isOnline } = require('../../socket');
const { CONTEXTS } = require('../../utils/automation/catalog');
const { timeSlot, stateHolds, todoFits, eventFits, contextTypesFor } = require('../../utils/automation/contextMatch');
const { runTask } = require('./runner');
const { exec, addDays } = require('./actions');

const CACHE_MS = 15 * 1000;
const TICK_MS = 20 * 1000;
const DEVICE_FRESH_MS = 10 * 60 * 1000;
const RUN_KEEP = 60;
const LIMITS = { perProfileMinute: 20, perOwnerHour: 300, perOwnerRunning: 3, runningTotal: 15, globalsPerOwner: 100 };

let cache = { at: 0, profiles: [] };
const actorCache = new Map(); // ownerId -> { at, actor }
const lastFire = new Map(); // profileId -> ms
const profileWindow = new Map(); // profileId -> [timestamps]
const ownerWindow = new Map(); // ownerId -> [timestamps]
const running = { total: 0, byOwner: new Map() };

// ---- small helpers ----------------------------------------------------------------------------------

function nowParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date: dateStr,
    tomorrow: addDays(dateStr, 1),
    hm: `${parts.hour}:${parts.minute}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    epochMinute: Math.floor(date.getTime() / 60000),
  };
}

async function actorOf(ownerId) {
  const hit = actorCache.get(ownerId);
  if (hit && Date.now() - hit.at < 30000) return hit.actor;
  const found = await loadActor(ownerId);
  const actor = found && found.status !== 'inactive' ? found : null;
  actorCache.set(ownerId, { at: Date.now(), actor });
  return actor;
}

async function profiles(force = false) {
  if (!force && Date.now() - cache.at < CACHE_MS) return cache.profiles;
  try {
    const rows = (await db.query(
      `SELECT p.id, p.owner_id, p.name, p.contexts, p.match_mode, p.enter_task_id, p.exit_task_id, p.cooldown_seconds,
              p.active, p.last_slot, p.last_fired_at, p.priority
       FROM automation_profiles p WHERE p.enabled ORDER BY p.priority, p.id`
    )).rows;
    cache = { at: Date.now(), profiles: rows.map((r) => ({
      ...r,
      eventCtx: (r.contexts || []).find((c) => CONTEXTS[c.type] && CONTEXTS[c.type].kind === 'event') || null,
      stateCtx: (r.contexts || []).filter((c) => CONTEXTS[c.type] && CONTEXTS[c.type].kind === 'state'),
    })) };
  } catch (err) {
    if (err.code !== '42P01') console.error('[automation] could not load profiles:', err.message);
    cache = { at: Date.now(), profiles: [] };
  }
  return cache.profiles;
}

/** Call after a profile is saved, switched or deleted so the engine sees it at once. */
function invalidate() { cache.at = 0; }

function allow(profile, via, manual) {
  if (manual) return true;
  const now = Date.now();
  if (via && (via.chain.includes(profile.id) || via.depth >= 3)) return false;
  if (now - (lastFire.get(profile.id) || 0) < (profile.cooldown_seconds || 0) * 1000) return false;
  const w = (profileWindow.get(profile.id) || []).filter((t) => now - t < 60000);
  if (w.length >= LIMITS.perProfileMinute) return false;
  const o = (ownerWindow.get(profile.owner_id) || []).filter((t) => now - t < 3600000);
  if (o.length >= LIMITS.perOwnerHour) return false;
  w.push(now); o.push(now);
  profileWindow.set(profile.id, w); ownerWindow.set(profile.owner_id, o);
  lastFire.set(profile.id, now);
  return true;
}

async function countsFor(ownerId, today) {
  const r = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE t.due_date < $2::date)::int AS overdue,
            COUNT(*) FILTER (WHERE t.due_date = $2::date)::int AS today,
            COUNT(*)::int AS open
     FROM todos t LEFT JOIN todo_members tm ON tm.todo_id = t.id AND tm.user_id = $1
     WHERE t.is_done = FALSE AND t.review_state = 'accepted'
       AND ((t.business_id IS NULL AND tm.user_id IS NOT NULL) OR t.assignee_id = $1)`,
    [ownerId, today]
  )).rows[0];
  return { overdue_count: r.overdue, today_count: r.today, open_count: r.open };
}

async function deviceFor(ownerId) {
  const row = (await db.query('SELECT state, updated_at FROM automation_device WHERE owner_id = $1', [ownerId])).rows[0];
  if (!row || Date.now() - new Date(row.updated_at).getTime() > DEVICE_FRESH_MS) return {};
  return row.state || {};
}

async function loadGlobals(ownerId) {
  const rows = (await db.query('SELECT name, value FROM automation_vars WHERE owner_id = $1', [ownerId])).rows;
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

async function saveGlobals(ownerId, changes) {
  for (const [name, value] of changes.set) {
    await db.query(
      `INSERT INTO automation_vars (owner_id, name, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [ownerId, name, String(value).slice(0, 2000)]
    );
  }
  if (changes.removed.length) await db.query('DELETE FROM automation_vars WHERE owner_id = $1 AND name = ANY($2::text[])', [ownerId, changes.removed]);
  await db.query(
    `DELETE FROM automation_vars WHERE owner_id = $1 AND name NOT IN
       (SELECT name FROM automation_vars WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2)`,
    [ownerId, LIMITS.globalsPerOwner]
  );
}

function tellOwner(ownerId, event, payload) {
  const io = getIO();
  if (io) io.to(`user:${ownerId}`).emit(event, payload);
}

// ---- running ----------------------------------------------------------------------------------------

/**
 * Run one task for its owner and record how it went. `vars` are the event's variables (%todo_title...).
 * Returns the stored run summary, or null if the run was refused (busy, owner gone).
 */
async function execute({ profile = null, task, ownerId, trigger, vars = {}, via = null }) {
  const owner = await actorOf(ownerId);
  if (!owner || !task) return null;
  const byOwner = running.byOwner.get(ownerId) || 0;
  if (running.total >= LIMITS.runningTotal || byOwner >= LIMITS.perOwnerRunning) return null;
  running.total += 1; running.byOwner.set(ownerId, byOwner + 1);
  try {
    const now = nowParts();
    const [globals, counts, device] = await Promise.all([loadGlobals(ownerId), countsFor(ownerId, now.date), deviceFor(ownerId)]);
    const initial = {
      ...counts,
      ...(typeof device.battery === 'number' ? { battery: device.battery, charging: !!device.charging } : {}),
      ...vars,
    };
    const store = { chain: [...((via && via.chain) || []), ...(profile ? [profile.id] : [])], depth: ((via && via.depth) || 0) + 1 };
    const deps = {
      exec,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      loadTask: async (id) => {
        if (!id) return null;
        const row = (await db.query('SELECT id, name, actions FROM automation_tasks WHERE id = $1 AND owner_id = $2', [id, ownerId])).rows[0];
        return row || null;
      },
    };
    const result = await als.run(store, () => runTask({ task, owner, trigger, now, globals, initial, deps, api: {} }));
    await saveGlobals(ownerId, result.globals).catch((err) => console.error('[automation] globals:', err.message));
    const stored = (await db.query(
      `INSERT INTO automation_runs (owner_id, profile_id, task_id, profile_name, task_name, trigger, status, error, steps, duration_ms, log)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, started_at`,
      [ownerId, profile ? profile.id : null, task.id || null, profile ? profile.name : null, task.name, String(trigger).slice(0, 60),
        result.status, result.error, result.steps, result.durationMs, JSON.stringify(result.log)]
    )).rows[0];
    await db.query(
      `DELETE FROM automation_runs WHERE owner_id = $1 AND id NOT IN
         (SELECT id FROM automation_runs WHERE owner_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2)`,
      [ownerId, RUN_KEEP]
    );
    if (profile) await db.query('UPDATE automation_profiles SET run_count = run_count + 1, last_fired_at = NOW() WHERE id = $1', [profile.id]);
    tellOwner(ownerId, 'automation:run', { id: stored.id, profileId: profile ? profile.id : null, status: result.status, error: result.error });
    return { id: stored.id, status: result.status, error: result.error, steps: result.steps, log: result.log, durationMs: result.durationMs };
  } catch (err) {
    console.error('[automation] run failed:', err.message);
    return null;
  } finally {
    running.total -= 1; running.byOwner.set(ownerId, Math.max(0, (running.byOwner.get(ownerId) || 1) - 1));
  }
}

async function taskById(id, ownerId) {
  if (!id) return null;
  return (await db.query('SELECT id, name, actions FROM automation_tasks WHERE id = $1 AND owner_id = $2', [id, ownerId])).rows[0] || null;
}

/** Start a profile's task. `which` is 'enter' (the normal one) or 'exit' (a state profile going quiet). */
async function fire(profile, { which = 'enter', trigger, vars = {}, via = null, manual = false }) {
  if (!allow(profile, via, manual)) return null;
  const task = await taskById(which === 'exit' ? profile.exit_task_id : profile.enter_task_id, profile.owner_id);
  if (!task) return null;
  return execute({ profile, task, ownerId: profile.owner_id, trigger, vars, via });
}

// ---- conditions that must also hold ------------------------------------------------------------------

async function conditionsHold(profile, facts) {
  if (!profile.stateCtx.length) return true;
  const results = profile.stateCtx.map((c) => stateHolds(c, facts));
  return profile.match_mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

async function factsFor(ownerId, now) {
  const [device, globals] = await Promise.all([deviceFor(ownerId), loadGlobals(ownerId)]);
  const facts = { now, appOpen: isOnline(ownerId), device, globals };
  const need = (profileList) => profileList.some((p) => p.stateCtx.some((c) => ['overdue_count', 'open_today_count'].includes(c.type)));
  const mine = cache.profiles.filter((p) => p.owner_id === ownerId);
  if (need(mine)) {
    const c = await countsFor(ownerId, now.date);
    facts.overdue = c.overdue_count; facts.todayCount = c.today_count;
  }
  return facts;
}

// ---- events -----------------------------------------------------------------------------------------

function todoVars(todo) {
  return {
    todo_id: todo.id,
    todo_title: todo.title,
    todo_notes: todo.notes || '',
    todo_status: todo.status,
    todo_priority: todo.priority,
    todo_due: todo.due_date || '',
    todo_deadline: todo.deadline_date || '',
    todo_labels: todo.labels || [],
    todo_business: todo.business_name || '',
    todo_business_id: todo.business_id || '',
    todo_assignee: todo.assignee_name || '',
    todo_by: todo.created_by_name || '',
  };
}

async function onTodoEvent(evt) {
  if (!evt.todoId) return;
  const list = await profiles();
  const types = evt.kind === 'comment' ? ['todo_commented'] : contextTypesFor(evt.kind);
  const candidates = list.filter((p) => p.eventCtx && types.includes(p.eventCtx.type));
  if (!candidates.length) return;
  const audience = new Set(evt.audience || await audienceIds(evt.todoId));
  const now = nowParts();
  for (const profile of candidates) {
    if (!audience.has(profile.owner_id)) continue;
    if (evt.via && (evt.via.chain.includes(profile.id) || evt.via.depth >= 3)) continue;
    const owner = await actorOf(profile.owner_id);
    if (!owner) continue;
    const todo = await getTodoFor(evt.todoId, owner.id, owner);
    if (!todo || !todoFits(profile.eventCtx, todo, owner.id) || !eventFits(profile.eventCtx, evt, owner.id)) continue;
    if (!(await conditionsHold(profile, await factsFor(owner.id, now)))) continue;
    const vars = { ...todoVars(todo), change_kind: evt.kind, status_from: evt.kind === 'status' ? evt.from : '', status_to: evt.kind === 'status' ? evt.to : '' };
    if (evt.kind === 'comment') {
      const c = (await db.query(
        `SELECT c.body, u.name FROM todo_comments c JOIN users u ON u.id = c.user_id WHERE c.todo_id = $1 ORDER BY c.id DESC LIMIT 1`, [todo.id]
      )).rows[0];
      vars.comment_text = c ? c.body : ''; vars.comment_by = c ? c.name : '';
    }
    await fire(profile, { trigger: evt.kind === 'comment' ? 'a comment' : `to-do ${evt.kind}`, vars, via: evt.via });
  }
}

async function onNotification(evt) {
  if (evt.type === 'automation') return;
  const mine = (await profiles()).filter((p) => p.owner_id === evt.userId && p.eventCtx && p.eventCtx.type === 'notification');
  for (const profile of mine) {
    const c = profile.eventCtx;
    if (c.ntype && c.ntype !== 'any' && c.ntype !== evt.type) continue;
    if (c.text && !`${evt.title} ${evt.text}`.toLowerCase().includes(String(c.text).toLowerCase())) continue;
    if (!(await conditionsHold(profile, await factsFor(profile.owner_id, nowParts())))) continue;
    await fire(profile, { trigger: 'a notification', vars: { notification_type: evt.type, notification_title: evt.title, notification_text: evt.text }, via: evt.via });
  }
}

async function onChat(evt) {
  const candidates = (await profiles()).filter((p) => p.eventCtx && p.eventCtx.type === 'chat_message' && p.owner_id !== evt.senderId);
  if (!candidates.length) return;
  const members = new Set((await db.query('SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [evt.conversationId])).rows.map((r) => r.user_id));
  for (const profile of candidates) {
    if (!members.has(profile.owner_id)) continue;
    const c = profile.eventCtx;
    if (parseInt(c.from, 10) && parseInt(c.from, 10) !== evt.senderId) continue;
    if (c.text && !String(evt.text).toLowerCase().includes(String(c.text).toLowerCase())) continue;
    if (!(await conditionsHold(profile, await factsFor(profile.owner_id, nowParts())))) continue;
    await fire(profile, {
      trigger: 'a chat message',
      vars: { message_text: evt.text, message_from: evt.senderName, message_from_id: evt.senderId, conversation_id: evt.conversationId },
      via: evt.via,
    });
  }
}

async function onAppOpened(evt) {
  const mine = (await profiles()).filter((p) => p.owner_id === evt.userId && p.eventCtx && p.eventCtx.type === 'app_opened');
  for (const profile of mine) {
    if (await conditionsHold(profile, await factsFor(profile.owner_id, nowParts()))) await fire(profile, { trigger: 'the app opening', via: evt.via });
  }
  await evaluateStatesFor(evt.userId);
}

// ---- states and the clock ---------------------------------------------------------------------------

/** Re-check one person's state profiles and run enter / exit tasks for the ones that changed. */
async function evaluateStatesFor(ownerId, factsIn = null) {
  const mine = (await profiles()).filter((p) => p.owner_id === ownerId && !p.eventCtx && p.stateCtx.length);
  if (!mine.length) return;
  const facts = factsIn || await factsFor(ownerId, nowParts());
  for (const profile of mine) {
    const holds = await conditionsHold(profile, facts);
    if (holds === !!profile.active) continue;
    const claimed = await db.query(
      'UPDATE automation_profiles SET active = $2 WHERE id = $1 AND active IS DISTINCT FROM $2 RETURNING id', [profile.id, holds]
    );
    profile.active = holds;
    if (!claimed.rows.length) continue; // another server instance got there first
    await fire(profile, { which: holds ? 'enter' : 'exit', trigger: holds ? 'it becoming true' : 'it ending' });
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const list = await profiles();
    if (!list.length) return;
    const now = nowParts();
    const owners = new Set();
    for (const profile of list) {
      const ctx = profile.eventCtx;
      if (ctx && ['time_at', 'interval', 'date_on'].includes(ctx.type)) {
        const slot = timeSlot(ctx, now, profile.last_slot);
        if (!slot) continue;
        const claimed = await db.query(
          'UPDATE automation_profiles SET last_slot = $2 WHERE id = $1 AND last_slot IS DISTINCT FROM $2 RETURNING id', [profile.id, slot]
        );
        profile.last_slot = slot;
        if (!claimed.rows.length) continue;
        if (await conditionsHold(profile, await factsFor(profile.owner_id, now))) {
          await fire(profile, { trigger: ctx.type === 'time_at' ? `${ctx.at}` : ctx.type === 'interval' ? 'the timer' : 'the date' });
        }
      } else if (!ctx && profile.stateCtx.length) owners.add(profile.owner_id);
    }
    for (const ownerId of owners) await evaluateStatesFor(ownerId);
  } catch (err) {
    console.error('[automation] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

// ---- entry points for routes -----------------------------------------------------------------------

/** "Run now" from the app. */
async function runProfileNow(profileRow, ownerId, which = 'enter') {
  const profile = { ...profileRow, owner_id: ownerId };
  const task = await taskById(which === 'exit' ? profile.exit_task_id : profile.enter_task_id, ownerId);
  if (!task) return { error: which === 'exit' ? 'This profile has no task for when it ends' : 'Choose a task for this profile first' };
  const result = await execute({ profile, task, ownerId, trigger: 'Run now' });
  return result ? { run: result } : { error: 'Another automation is still running. Try again in a moment' };
}

async function runTaskNow(taskRow, ownerId, par1 = '') {
  const result = await execute({ task: taskRow, ownerId, trigger: 'Run now', vars: { par1 } });
  return result ? { run: result } : { error: 'Another automation is still running. Try again in a moment' };
}

/** A call to a profile's secret web link. */
async function runWebhook(profileRow, vars) {
  invalidate();
  const profile = { ...profileRow };
  return fire({ ...profile, stateCtx: [], eventCtx: { type: 'webhook' } }, { trigger: 'a web link', vars });
}

let started = false;
function start() {
  if (started) return;
  started = true;
  const guard = (fn) => (evt) => { fn(evt).catch((err) => console.error('[automation] event failed:', err.message)); };
  bus.on('todo_event', guard(onTodoEvent));
  bus.on('notification', guard(onNotification));
  bus.on('chat_message', guard(onChat));
  bus.on('app_opened', guard(onAppOpened));
  bus.on('app_closed', guard((evt) => evaluateStatesFor(evt.userId)));
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('[automation] engine started');
}

module.exports = { start, invalidate, tick, execute, runProfileNow, runTaskNow, runWebhook, evaluateStatesFor, nowParts, profiles, todoVars };
