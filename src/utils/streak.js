/**
 * Streak maths, kept free of the database so it can be tested.
 *
 * A day "counts" when the person finished at least one thing. Weekends and chosen rest days never break
 * a streak (they do not add to it either), and neither does today while it is still in progress.
 */

function utcDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function shift(ymd, delta) {
  const d = utcDate(ymd);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function isWeekend(ymd) {
  const dow = utcDate(ymd).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * @param {Map<string, number>} byDay  completions per 'YYYY-MM-DD'
 * @param {Set<string>} rests          chosen rest days
 * @param {string} today
 * @returns {{ current: number, longest: number }}
 */
function computeStreak(byDay, rests, today) {
  let current = 0;
  let cursor = today;
  for (let guard = 0; guard < 800; guard += 1) {
    if (byDay.get(cursor) > 0) current += 1;
    else if (cursor === today || isWeekend(cursor) || rests.has(cursor)) { /* bridged */ } else break;
    cursor = shift(cursor, -1);
  }

  const days = [...byDay.keys()].sort();
  let longest = 0;
  if (days.length) {
    let run = 0;
    for (let day = days[0]; day <= today; day = shift(day, 1)) {
      if (byDay.get(day) > 0) {
        run += 1;
        if (run > longest) longest = run;
      } else if (!(day === today || isWeekend(day) || rests.has(day))) {
        run = 0;
      }
    }
  }
  return { current, longest: Math.max(longest, current) };
}

module.exports = { computeStreak, shift, isWeekend };
