/**
 * Pure maths for the business workspace: cumulative flow, lead and cycle time by week, WIP limits, sprint capacity.
 * Dates are 'YYYY-MM-DD' strings and all day arithmetic is done in UTC so no server timezone leaks in.
 */
const { addDaysYmd } = require('./sprints');

const STATUS_ORDER = ['todo', 'in_progress', 'blocked', 'in_review', 'on_hold', 'done'];
const WIP_STATUSES = ['in_progress', 'blocked', 'in_review', 'on_hold'];
const ITEM_TYPES = ['task', 'feature', 'bug'];
const MAX_WIP = 99;

/** Status of one item at the end of a day, or null before it existed. */
function statusOn(item, day) {
  if (item.createdOn > day) return null;
  let status = 'todo';
  for (const t of item.transitions) {
    if (t.on <= day) status = t.status;
    else break;
  }
  return status;
}

/**
 * Cumulative flow: for each day, how many items sat in each status at the end of it.
 * `items`: [{ createdOn, transitions: [{ on, status }] sorted by time, current }]. On `today` the real status wins,
 * so the last bar is right even when the history misses a change.
 */
function cumulativeFlow({ days, items, today }) {
  return days.map((day) => {
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    for (const item of items) {
      const status = day === today && item.current ? (item.createdOn <= day ? item.current : null) : statusOn(item, day);
      if (status && counts[status] !== undefined) counts[status] += 1;
    }
    return { date: day, ...counts };
  });
}

/** The last `n` calendar days ending on `today`, oldest first. */
function lastDays(today, n) {
  return Array.from({ length: n }, (_, i) => addDaysYmd(today, i - (n - 1)));
}

/** Monday of the week a day falls in. */
function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDaysYmd(ymd, -dow);
}

/** Mondays of the last `n` weeks, oldest first, the current week last. */
function lastWeeks(today, n) {
  const thisWeek = weekStart(today);
  return Array.from({ length: n }, (_, i) => addDaysYmd(thisWeek, (i - (n - 1)) * 7));
}

const hours = (seconds) => Math.round((seconds / 3600) * 10) / 10;

/**
 * Throughput, lead time (created to done) and cycle time (started to done) per week.
 * `items`: [{ doneOn, leadS, cycleS }]. Weeks without finished work report null averages.
 */
function leadCycleByWeek(items, weeks) {
  return weeks.map((week) => {
    const mine = items.filter((it) => it.doneOn && weekStart(it.doneOn) === week);
    if (!mine.length) return { week, done: 0, lead_h: null, cycle_h: null };
    const lead = mine.reduce((sum, it) => sum + (it.leadS || 0), 0) / mine.length;
    const cycle = mine.reduce((sum, it) => sum + (it.cycleS || 0), 0) / mine.length;
    return { week, done: mine.length, lead_h: hours(lead), cycle_h: hours(cycle) };
  });
}

/** WIP limits from a request body: only known statuses, whole numbers from 1 to 99. */
function cleanWip(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const status of WIP_STATUSES) {
    const n = Number(raw[status]);
    if (raw[status] !== null && raw[status] !== undefined && raw[status] !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_WIP) out[status] = n;
  }
  return out;
}

/** Whether a sprint's planned points are light, about right, or more than the team usually finishes. */
function capacityLevel(plannedPoints, averageVelocity) {
  if (averageVelocity === null || averageVelocity === undefined || averageVelocity <= 0) return 'unknown';
  if (plannedPoints > averageVelocity * 1.15) return 'over';
  if (plannedPoints < averageVelocity * 0.6) return 'under';
  return 'ok';
}

module.exports = {
  STATUS_ORDER,
  WIP_STATUSES,
  ITEM_TYPES,
  MAX_WIP,
  cumulativeFlow,
  lastDays,
  weekStart,
  lastWeeks,
  leadCycleByWeek,
  cleanWip,
  capacityLevel,
};
