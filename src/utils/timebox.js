/**
 * Timebox planner (migration 058): the shape of one day's box, validated, and its numbers. Pure, unit-tested.
 *
 * A box is the classic timeboxing page: a brain dump (everything on your mind), the top three priorities picked
 * from it, and the day split into half-hour blocks, each holding one piece of work. At the end of the day each
 * block is marked done or not and a short note says how it went; then the box is sent to the people above.
 */

const MAX_PRIORITIES = 3;
const MAX_DUMP = 60;
const MAX_BLOCKS = 48;
const STEP = 30; // minutes; blocks start and end on the hour or the half hour

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (hm) => { const m = HM.exec(hm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toHM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const todoId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const doneOf = (v) => (v === true ? true : v === false ? false : null);

function cleanItems(raw, max) {
  return (Array.isArray(raw) ? raw : [])
    .map((it) => (typeof it === 'string' ? { text: it } : it || {}))
    .map((it) => ({ text: text(it.text, 300), todo_id: todoId(it.todo_id), done: it.done === true }))
    .filter((it) => it.text)
    .slice(0, max);
}

/**
 * Validate a box sent by the client. Returns { box, errors }; the box is safe to store even when errors is not empty
 * (overlapping or broken blocks are left out and reported).
 */
function cleanBox(raw = {}) {
  const errors = [];
  const priorities = cleanItems(raw.priorities, MAX_PRIORITIES + 10);
  if (priorities.length > MAX_PRIORITIES) errors.push(`Keep it to ${MAX_PRIORITIES} top priorities`);
  const brainDump = cleanItems(raw.brain_dump, MAX_DUMP);

  const blocks = [];
  const candidates = (Array.isArray(raw.blocks) ? raw.blocks : []).slice(0, MAX_BLOCKS * 2)
    .map((b) => ({ ...(b || {}), s: toMin(b?.start), e: toMin(b?.end) }))
    .sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
  for (const b of candidates) {
    const label = text(b.text, 300);
    if (b.s === null || b.e === null) { errors.push('A block has a time that is not HH:MM'); continue; }
    if (b.s % STEP || b.e % STEP) { errors.push(`${b.start}: blocks start and end on the hour or half hour`); continue; }
    if (b.e <= b.s) { errors.push(`${b.start}: a block must end after it starts`); continue; }
    if (!label && !todoId(b.todo_id)) continue; // an empty slot is simply not stored
    const prev = blocks[blocks.length - 1];
    if (prev && toMin(prev.end) > b.s) { errors.push(`${b.start} overlaps ${prev.start}`); continue; }
    const p = b.priority === null || b.priority === undefined || b.priority === '' ? NaN : Number(b.priority); // Number(null) is 0
    blocks.push({
      start: toHM(b.s), end: toHM(b.e), text: label, todo_id: todoId(b.todo_id),
      priority: Number.isInteger(p) && p >= 0 && p < MAX_PRIORITIES ? p : null, done: doneOf(b.done),
    });
    if (blocks.length >= MAX_BLOCKS) break;
  }

  return {
    box: { priorities: priorities.slice(0, MAX_PRIORITIES), brain_dump: brainDump, blocks, reflection: text(raw.reflection, 4000) },
    errors,
  };
}

/** 'none' (nothing written), 'planned' (something written, not sent) or 'sent'. */
function statusOf(row) {
  if (!row) return 'none';
  if (row.submitted_at) return 'sent';
  const has = (row.priorities || []).length || (row.blocks || []).length || (row.brain_dump || []).length || row.reflection;
  return has ? 'planned' : 'none';
}

/** The numbers shown on a box and in the team list. */
function summarize(row) {
  const blocks = row?.blocks || [];
  const priorities = row?.priorities || [];
  const mins = (b) => toMin(b.end) - toMin(b.start);
  const planned = blocks.reduce((s, b) => s + mins(b), 0);
  const done = blocks.filter((b) => b.done === true).reduce((s, b) => s + mins(b), 0);
  const marked = blocks.filter((b) => b.done !== null && b.done !== undefined).length;
  return {
    status: statusOf(row),
    priorities: priorities.length,
    priorities_done: priorities.filter((p) => p.done).length,
    blocks: blocks.length,
    blocks_done: blocks.filter((b) => b.done === true).length,
    blocks_marked: marked,
    planned_minutes: planned,
    done_minutes: done,
    percent: planned ? Math.round((done / planned) * 100) : null,
    first: blocks[0]?.start || null,
    last: blocks[blocks.length - 1]?.end || null,
  };
}

/** Can the owner still change the box of `date`? Today, tomorrow and later, or yesterday's while it is unsent. */
function editable(date, today, row) {
  if (row?.submitted_at) return false;
  const dayMs = 86400000;
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs);
  return diff >= -1 && diff <= 14;
}

/** May this box be sent? It needs at least one block or priority, and it cannot be sent before its own day. */
function sendProblem(date, today, row) {
  if (!row) return 'Write your timebox first';
  if (row.submitted_at) return 'Already sent';
  if (date > today) return 'You can send it on the day itself';
  if (!(row.blocks || []).length && !(row.priorities || []).length) return 'Add at least one priority or one block';
  return null;
}

module.exports = { cleanBox, statusOf, summarize, editable, sendProblem, toMin, toHM, MAX_PRIORITIES, STEP };
