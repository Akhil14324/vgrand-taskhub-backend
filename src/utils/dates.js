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
  const d = new Date(date);
  const year = d.getFullYear();
  const month = MONTHS[d.getMonth()];
  const day = d.getDate();
  return `${month} ${day}, ${year}`;
}

function formatOverdueMessage({ title, business_name, due_date }) {
  return `Task "${title}" (${business_name}) is overdue. Due date was ${formatDate(due_date)}.`;
}

module.exports = { formatDate, formatOverdueMessage };
