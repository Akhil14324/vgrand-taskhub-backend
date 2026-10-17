/**
 * Pure checks for automation contexts: does this moment fit a time context, does this to-do event fit a
 * to-do context, does a state context hold right now. No database in here, so it is unit-tested.
 */
const { evalComparison } = require('./expr');

const toMinutes = (hm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** `now` = { date: 'YYYY-MM-DD', hm: 'HH:MM', dow: 0-6 (0 = Sunday), epochMinute } in the app's time zone. */
function dayOk(ctx, now) {
  return !Array.isArray(ctx.days) || ctx.days.length === 0 || ctx.days.includes(now.dow);
}

/** Whether a time context should fire at this minute; returns the slot key to remember, or null. */
function timeSlot(ctx, now, lastSlot) {
  const nowMin = toMinutes(now.hm);
  if (ctx.type === 'time_at') {
    if (!dayOk(ctx, now)) return null;
    const at = toMinutes(ctx.at);
    if (at === null) return null;
    // Within 3 minutes after the moment, so a short pause of the server does not skip it.
    if (nowMin < at || nowMin - at > 3) return null;
    const slot = `${now.date}T${ctx.at}`;
    return slot === lastSlot ? null : slot;
  }
  if (ctx.type === 'date_on') {
    if (ctx.date !== now.date) return null;
    const at = toMinutes(ctx.at) ?? 540;
    if (nowMin < at || nowMin - at > 3) return null;
    const slot = `${now.date}T${ctx.at}`;
    return slot === lastSlot ? null : slot;
  }
  if (ctx.type === 'interval') {
    if (!dayOk(ctx, now)) return null;
    const every = Math.max(5, Number(ctx.every) || 30);
    const from = toMinutes(ctx.from);
    const to = toMinutes(ctx.to);
    if (from !== null && nowMin < from) return null;
    if (to !== null && nowMin > to) return null;
    if (now.epochMinute % every !== 0) return null;
    const slot = `${now.date}T${now.hm}`;
    return slot === lastSlot ? null : slot;
  }
  return null;
}

/** A state context "between two times" (may run past midnight). */
function inTimeRange(ctx, now) {
  const from = toMinutes(ctx.from);
  const to = toMinutes(ctx.to);
  const nowMin = toMinutes(now.hm);
  if (from === null || to === null || nowMin === null) return false;
  if (!dayOk(ctx, now)) return false;
  return from <= to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to;
}

function metres(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Does a state context hold? `facts` = { now, overdue, todayCount, appOpen, device: {battery, charging,
 * online, lat, lon}, globals: Map|object }. A device fact that is unknown makes the state false (we
 * never guess about somebody's phone).
 */
function stateHolds(ctx, facts) {
  switch (ctx.type) {
    case 'time_range': return inTimeRange(ctx, facts.now);
    case 'overdue_count': return (facts.overdue || 0) >= (Number(ctx.min) || 1);
    case 'open_today_count': return ctx.cmp === 'le' ? (facts.todayCount || 0) <= Number(ctx.n) : (facts.todayCount || 0) >= Number(ctx.n);
    case 'app_open': return ctx.is === 'closed' ? !facts.appOpen : !!facts.appOpen;
    case 'battery': {
      const d = facts.device || {};
      if (typeof d.battery !== 'number') return false;
      const level = ctx.cmp === 'ge' ? d.battery >= Number(ctx.percent) : d.battery <= Number(ctx.percent);
      if (ctx.charging === 'yes') return level && d.charging === true;
      if (ctx.charging === 'no') return level && d.charging === false;
      return level;
    }
    case 'online': {
      const d = facts.device || {};
      if (typeof d.online !== 'boolean') return false;
      return ctx.is === 'offline' ? !d.online : d.online;
    }
    case 'place': {
      const d = facts.device || {};
      if (typeof d.lat !== 'number' || typeof d.lon !== 'number' || ctx.lat === null || ctx.lon === null) return false;
      const inside = metres(d.lat, d.lon, Number(ctx.lat), Number(ctx.lon)) <= Number(ctx.radius || 150);
      return ctx.is === 'outside' ? !inside : inside;
    }
    case 'variable': {
      const g = facts.globals || {};
      const lookup = (name) => (g instanceof Map ? g.get(name) : g[name]);
      try { return evalComparison(ctx.cond || {}, lookup); } catch { return false; }
    }
    default: return false;
  }
}

/** Does a to-do fit the filters of a to-do context? `todo` is the row the viewer sees. */
function todoFits(ctx, todo, ownerId) {
  if (!todo) return false;
  if (ctx.scope === 'mine') {
    const mine = todo.assignee_id === ownerId || (todo.members || []).some((m) => m.id === ownerId) || (!todo.business_id && todo.created_by === ownerId);
    if (!mine) return false;
  }
  if (ctx.scope === 'business' && Number(todo.business_id) !== Number(ctx.business_id)) return false;
  if (ctx.text && !String(todo.title || '').toLowerCase().includes(String(ctx.text).toLowerCase())) return false;
  if (ctx.label && !(todo.labels || []).map((l) => String(l).toLowerCase()).includes(String(ctx.label).toLowerCase().replace(/^@/, ''))) return false;
  return true;
}

/** The context type a logged to-do event kind belongs to. */
const KIND_TO_CONTEXT = {
  created: 'todo_created',
  completed: 'todo_completed',
  reopened: 'todo_reopened',
  status: 'todo_status',
  assigned: 'todo_assigned',
  priority_changed: 'todo_priority',
  due_changed: 'todo_due_changed',
  deadline_changed: 'todo_due_changed',
  comment: 'todo_commented',
};

/** Which context types a to-do event of this kind can start (its own, and "changes in any way"). */
function contextTypesFor(kind) {
  const own = KIND_TO_CONTEXT[kind];
  const list = [];
  if (own) list.push(own);
  if (kind !== 'comment' && kind !== 'created' && kind !== 'shared') list.push('todo_changed');
  return list;
}

/** Event-specific checks on top of todoFits (the status it moved to, the priority it became, who it went to). */
function eventFits(ctx, evt, ownerId) {
  if (ctx.type === 'todo_status') return !ctx.to || ctx.to === 'any' || ctx.to === evt.to;
  if (ctx.type === 'todo_priority') {
    if (!ctx.to || ctx.to === 'any') return true;
    return String(evt.to || '').replace(/^P/i, '') === String(ctx.to);
  }
  if (ctx.type === 'todo_assigned') return evt.subjectId === ownerId && !!evt.to;
  return true;
}

module.exports = { timeSlot, inTimeRange, stateHolds, todoFits, eventFits, contextTypesFor, KIND_TO_CONTEXT, metres, toMinutes };
