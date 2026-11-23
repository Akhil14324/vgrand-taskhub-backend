// Checks what the model (or a client) asks the assistant to change, before anything is shown to the person
// and again before anything is done. The model only ever PROPOSES; this decides whether a proposal is
// well-formed. Whether the person is ALLOWED to do it is decided by the app's own API when it is carried out.

const PRIORITY_LABEL = { 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
const MAX_STEPS = 15;

/** A calendar date written YYYY-MM-DD that exists (not 2026-02-31). */
const isRealDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // 2026-13-01 is an invalid Date, 2026-02-31 rolls over
};
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function requireId(args) {
  const n = Number(args.id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('That to-do id is not valid. Search for the to-do first.');
  return n;
}

function requireText(value, max, what) {
  const s = clean(value, max);
  if (!s) throw new Error(`The ${what} is empty`);
  return s;
}

function stepList(args, min = 0) {
  const seen = new Set();
  const steps = [];
  (Array.isArray(args.steps) ? args.steps : []).forEach((s) => {
    const t = clean(s, 300);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); steps.push(t); }
  });
  if (steps.length < min) throw new Error('Give at least one step');
  return steps.slice(0, MAX_STEPS);
}

function optionalDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isRealDate(value)) throw new Error(`The date "${clean(value, 20)}" is not valid. Use YYYY-MM-DD.`);
  return value;
}

function optionalTime(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isTime(value)) throw new Error(`The time "${clean(value, 10)}" is not valid. Use HH:MM.`);
  return value;
}

function optionalPriority(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const p = Number(value);
  if (![1, 2, 3, 4].includes(p)) throw new Error('Priority must be 1 (urgent) to 4 (low)');
  return p;
}

/** The names of tools whose effect cannot be undone. They need the person's explicit confirmation. */
const DANGEROUS = new Set(['delete_todo']);

/**
 * Returns the cleaned arguments of an action, or throws an Error whose message is safe to show (and to give back
 * to the model so it can correct itself). Unknown keys are dropped; nothing from the input is trusted as-is.
 */
function validateAction(tool, input) {
  const a = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'create_todo': {
      const out = { title: requireText(a.title, 500, 'title'), steps: stepList(a) };
      const notes = clean(a.notes, 2000);
      if (notes) out.notes = notes;
      const who = clean(a.assignee_username, 60).replace(/^@/, '');
      if (who) out.assignee_username = who;
      const date = optionalDate(a.due_date);
      if (date) out.due_date = date;
      const time = optionalTime(a.due_time);
      if (time) out.due_time = time;
      const priority = optionalPriority(a.priority);
      if (priority) out.priority = priority;
      return out;
    }
    case 'reschedule_todo': {
      const due = optionalDate(a.due_date);
      if (!due) throw new Error('A new date is needed');
      const out = { id: requireId(a), due_date: due };
      const time = optionalTime(a.due_time);
      if (time) out.due_time = time;
      return out;
    }
    case 'complete_todo':
    case 'delete_todo':
      return { id: requireId(a) };
    case 'assign_todo': {
      const who = clean(a.username, 60).replace(/^@/, '');
      if (!who) throw new Error('Who should it be given to?');
      return { id: requireId(a), username: who };
    }
    case 'add_comment':
      return { id: requireId(a), text: requireText(a.text, 2000, 'comment') };
    case 'add_steps':
      return { id: requireId(a), steps: stepList(a, 1) };
    case 'set_priority': {
      const priority = optionalPriority(a.priority);
      if (!priority) throw new Error('Priority must be 1 (urgent) to 4 (low)');
      return { id: requireId(a), priority };
    }
    default:
      throw new Error('That is not something the assistant can do');
  }
}

module.exports = { validateAction, isRealDate, isTime, DANGEROUS, PRIORITY_LABEL, MAX_STEPS };
