// Overdue roast: a light, private joke about a task (never about the person) that has sat overdue for a while.
const MIN_DAYS_LATE = 3;
const REPEAT_DAYS = 3;

const LINES = [
  (t, d) => `"${t}" has been overdue for ${d} days. It is starting to take it personally.`,
  (t, d) => `Day ${d} of "${t}" sitting there overdue. It has started decorating the place.`,
  (t, d) => `"${t}" asked us to check you are still around. It has been ${d} days.`,
  (t, d) => `${d} days overdue: "${t}" is now officially a long-term relationship.`,
  (t, d) => `"${t}" would like a word. It has waited ${d} days.`,
  (t, d) => `Fun fact: "${t}" has been overdue for ${d} days. Today could be its big day.`,
];

/** One line for this task; the same task gets a different line each time (`round`). */
function roastLine(title, daysLate, round = 0) {
  const clean = String(title || 'This task').trim().slice(0, 60);
  return LINES[Math.abs(round) % LINES.length](clean, daysLate);
}

/** Whole days between two 'YYYY-MM-DD' strings (later minus earlier). */
function daysBetween(earlier, later) {
  const [ay, am, ad] = earlier.split('-').map(Number);
  const [by, bm, bd] = later.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

module.exports = { roastLine, daysBetween, MIN_DAYS_LATE, REPEAT_DAYS, LINES };
