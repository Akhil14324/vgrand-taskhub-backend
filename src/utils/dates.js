const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * Format a JS Date as a clean calendar date, e.g. "Jul 23, 2026".
 * Postgres DATE columns are parsed as local midnight by node-postgres, so we
 * use the local calendar getters to preserve the stored date regardless of
 * the server's UTC offset.
 */
function formatDate(date) {
  // DATE columns arrive as 'YYYY-MM-DD' strings (see db/index.js); read them as
  // a local calendar date rather than UTC midnight.
  const ymd = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').map(Number) : null;
  const d = ymd ? new Date(ymd[0], ymd[1] - 1, ymd[2]) : new Date(date);
  const year = d.getFullYear();
  const month = MONTHS[d.getMonth()];
  const day = d.getDate();
  return `${month} ${day}, ${year}`;
}

function formatOverdueMessage({ title, business_name, due_date }) {
  return `Task "${title}" (${business_name}) is overdue. Due date was ${formatDate(due_date)}.`;
}

module.exports = { formatDate, formatOverdueMessage };
