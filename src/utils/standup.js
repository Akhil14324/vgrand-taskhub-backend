/** Stand-up helpers kept free of the database so they can be tested. */

const utcDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const ymd = (date) => date.toISOString().slice(0, 10);

/** The last working day before `today` (weekends are skipped): Monday looks back to Friday. */
function lastWorkDay(today) {
  const d = utcDate(today);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return ymd(d);
}

const isWeekend = (day) => [0, 6].includes(utcDate(day).getUTCDay());

/** Keep a posted list tidy: only {id, title}, trimmed, no duplicates, at most `max` of them. */
function cleanItems(list, max = 12) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const title = String(raw?.title ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
    if (!title) continue;
    const id = Number.isInteger(raw?.id) ? raw.id : null;
    const key = id ?? title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, title });
    if (out.length >= max) break;
  }
  return out;
}

/** "Done 3 · Today 4 · Blocked 1" for a notification. */
function summary({ done = [], doing = [], blockers = [] }) {
  return [`Done ${done.length}`, `Today ${doing.length}`, blockers.length ? `Blocked ${blockers.length}` : null].filter(Boolean).join(' · ');
}

module.exports = { lastWorkDay, isWeekend, cleanItems, summary };
