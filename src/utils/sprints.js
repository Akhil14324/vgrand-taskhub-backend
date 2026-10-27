/**
 * Pure sprint maths: point validation, sprint totals, the burndown series and velocity.
 * Dates are 'YYYY-MM-DD' strings throughout; arithmetic is done in UTC so no server timezone leaks in.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POINTS = 100;
const VELOCITY_WINDOW = 3;

/** Story points are a whole number from 0 to 100, or unset (null). Returns { value } or { error }. */
function cleanPoints(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_POINTS) return { error: `Story points must be a whole number from 0 to ${MAX_POINTS}` };
  return { value: n };
}

function isYmd(value) {
  return YMD.test(String(value || ''));
}

/** Adds n calendar days to a 'YYYY-MM-DD' string. */
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Number of calendar days from a to b, both included. */
function daysInclusive(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

/** Totals for a set of tasks: [{ points, is_done }]. */
function summarize(items) {
  let totalPoints = 0;
  let donePoints = 0;
  let doneCount = 0;
  for (const item of items) {
    const points = item.points || 0;
    totalPoints += points;
    if (item.is_done) {
      donePoints += points;
      doneCount += 1;
    }
  }
  return { total_count: items.length, done_count: doneCount, total_points: totalPoints, done_points: donePoints };
}

/**
 * Burndown for a sprint: one entry per calendar day from start to end.
 * `ideal` falls in a straight line from the total to zero. `remaining` is the points still open at the end of
 * that day, read from when each task was finished (`doneOn`); it is null for days after `today`.
 * Tasks are counted as they are now, so a task added or removed mid-sprint moves the whole line.
 *
 * @param {{ startsOn: string, endsOn: string, today: string, items: Array<{ points: number, doneOn: string|null }> }} input
 */
function burndown({ startsOn, endsOn, today, items }) {
  const days = daysInclusive(startsOn, endsOn);
  const total = items.reduce((sum, item) => sum + (item.points || 0), 0);
  const series = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDaysYmd(startsOn, i);
    const ideal = days === 1 ? 0 : Math.round((total * (days - 1 - i)) / (days - 1));
    let remaining = null;
    if (date <= today) {
      const finished = items.reduce((sum, item) => (item.doneOn && item.doneOn <= date ? sum + (item.points || 0) : sum), 0);
      remaining = total - finished;
    }
    series.push({ date, ideal, remaining });
  }
  return series;
}

/** Average points finished per sprint over the last few completed sprints; null when there are none yet. */
function averageVelocity(completedPoints) {
  if (!completedPoints.length) return null;
  const recent = completedPoints.slice(-VELOCITY_WINDOW);
  const sum = recent.reduce((acc, n) => acc + n, 0);
  return Math.round((sum / recent.length) * 10) / 10;
}

module.exports = {
  MAX_POINTS,
  VELOCITY_WINDOW,
  cleanPoints,
  isYmd,
  addDaysYmd,
  daysInclusive,
  summarize,
  burndown,
  averageVelocity,
};
