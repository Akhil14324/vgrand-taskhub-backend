/**
 * Template trees, kept free of the database so they can be tested.
 *
 * A node: { title, notes?, priority?, offset_days?, deadline_offset_days?, due_time?, duration_minutes?,
 *           labels?, recurrence?, children? }. Dates are offsets from the day the template is used.
 */

const MAX_ITEMS = 120;
const MAX_TREE_DEPTH = 6;
const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

const cleanText = (v, max) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').trim().slice(0, max);
const int = (v, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** Validate and normalise a tree from the client. Returns { tree, count } or { error }. */
function sanitizeTree(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'Add at least one task' };
  let count = 0;
  let failed = null;

  const clean = (node, depth) => {
    if (failed) return null;
    if (depth > MAX_TREE_DEPTH) { failed = `Sub-tasks can go ${MAX_TREE_DEPTH} levels deep in a template`; return null; }
    const title = cleanText(node && node.title, 500);
    if (!title) { failed = 'Every task needs a title'; return null; }
    count += 1;
    if (count > MAX_ITEMS) { failed = `A template can hold up to ${MAX_ITEMS} tasks`; return null; }
    const out = { title };
    const notes = cleanText(node.notes, 5000);
    if (notes) out.notes = notes;
    const priority = int(node.priority, 1, 4);
    if (priority && priority !== 4) out.priority = priority;
    const offset = int(node.offset_days, -365, 3650);
    if (offset !== null) out.offset_days = offset;
    const deadline = int(node.deadline_offset_days, -365, 3650);
    if (deadline !== null) out.deadline_offset_days = deadline;
    const time = String(node.due_time || '').match(/^(\d{1,2}):(\d{2})/);
    if (time && Number(time[1]) < 24 && Number(time[2]) < 60) out.due_time = `${time[1].padStart(2, '0')}:${time[2]}`;
    const duration = int(node.duration_minutes, 1, 14400);
    if (duration) out.duration_minutes = duration;
    if (Array.isArray(node.labels)) {
      const labels = [...new Set(node.labels.map((l) => String(l).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 10);
      if (labels.length) out.labels = labels;
    }
    if (depth === 0 && RECURRENCES.includes(node.recurrence)) out.recurrence = node.recurrence;
    const kids = Array.isArray(node.children) ? node.children.map((c) => clean(c, depth + 1)).filter(Boolean) : [];
    if (kids.length) out.children = kids;
    return out;
  };

  const tree = input.map((n) => clean(n, 0)).filter(Boolean);
  if (failed) return { error: failed };
  return { tree, count };
}

function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function daysBetween(fromYmd, toYmd) {
  const a = fromYmd.split('-').map(Number);
  const b = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

/** {month} {year} {date} {week} in titles become the start day's values: "GST filing {month}". */
function fillTokens(text, startYmd) {
  const [y, m, d] = startYmd.split('-').map(Number);
  return String(text)
    .replace(/\{month\}/gi, `${MONTHS[m - 1]} ${y}`)
    .replace(/\{year\}/gi, String(y))
    .replace(/\{date\}/gi, `${d} ${MONTHS_SHORT[m - 1]} ${y}`)
    .replace(/\{week\}/gi, `week of ${d} ${MONTHS_SHORT[m - 1]}`);
}

/**
 * Turn flat to-do rows (id, parent_id, due_date, deadline_date, ...) into a tree rooted at `rootId`.
 * Dates become offsets from the root's due date (or its earliest date when it has none).
 */
function treeFromRows(rows, rootId) {
  const byParent = new Map();
  rows.forEach((r) => {
    if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
    byParent.get(r.parent_id).push(r);
  });
  const root = rows.find((r) => r.id === rootId);
  if (!root) return [];
  const anchor = root.due_date || rows.map((r) => r.due_date).filter(Boolean).sort()[0] || null;

  const build = (row, depth) => {
    const node = { title: row.title };
    if (row.notes) node.notes = row.notes;
    if (row.priority && row.priority !== 4) node.priority = row.priority;
    if (anchor && row.due_date) node.offset_days = daysBetween(anchor, row.due_date);
    if (anchor && row.deadline_date) node.deadline_offset_days = daysBetween(anchor, row.deadline_date);
    if (row.due_time) node.due_time = String(row.due_time).slice(0, 5);
    if (row.duration_minutes) node.duration_minutes = row.duration_minutes;
    if (row.labels && row.labels.length) node.labels = row.labels;
    if (depth === 0 && row.recurrence) node.recurrence = row.recurrence;
    const kids = (byParent.get(row.id) || []).sort((a, b) => a.id - b.id).map((k) => build(k, depth + 1));
    if (kids.length) node.children = kids;
    return node;
  };
  return [build(root, 0)];
}

module.exports = { sanitizeTree, fillTokens, treeFromRows, addDays, daysBetween, MAX_ITEMS };
