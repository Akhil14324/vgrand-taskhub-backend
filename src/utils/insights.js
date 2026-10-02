// Pure helpers behind the leadership views: business health, workload balance, estimate accuracy and goal progress.

const WORK_DAY_MIN = 360; // six focused hours a day
const DEFAULT_TASK_MIN = 60; // what a to-do without an estimate is assumed to take
const WORK_DAYS_AHEAD = 5;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * 0-100 for one business. Starts full and loses points for overdue work, stuck work, work nobody owns and
 * late finishes. `open` of zero is a clean slate, not a problem.
 */
function healthScore({ open, overdue, blocked, unassigned, on_time_rate }) {
  if (!open && on_time_rate === null) return 100;
  const share = (n) => (open ? Math.min(1, n / open) : 0);
  let score = 100;
  score -= share(overdue) * 40;
  score -= share(blocked) * 25;
  score -= share(unassigned) * 10;
  if (on_time_rate !== null && on_time_rate !== undefined) score -= ((100 - on_time_rate) / 100) * 25;
  return Math.round(clamp(score, 0, 100));
}

const healthLevel = (score) => (score >= 75 ? 'green' : score >= 50 ? 'orange' : 'red');

/** The plain-language reasons a business needs a look. */
function attentionReasons(b) {
  const out = [];
  if (b.overdue) out.push(`${b.overdue} overdue`);
  if (b.blocked) out.push(`${b.blocked} stuck`);
  if (b.unassigned) out.push(`${b.unassigned} with no owner`);
  if (b.on_time_rate !== null && b.on_time_rate < 60) out.push(`only ${b.on_time_rate}% finished on time`);
  if (b.completed_change !== null && b.completed_change <= -30) out.push(`output down ${Math.abs(b.completed_change)}%`);
  return out;
}

/** Minutes of work a person has in front of them: overdue, due within the week, or already started. */
function loadMinutes(tasks, today, weekEnd) {
  let total = 0;
  for (const t of tasks) {
    const soon = t.due_date && t.due_date <= weekEnd;
    if (!soon && t.status !== 'in_progress') continue;
    total += t.duration_minutes || DEFAULT_TASK_MIN;
  }
  void today;
  return total;
}

function workloadState(minutes, capacity = WORK_DAY_MIN * WORK_DAYS_AHEAD) {
  const ratio = capacity ? minutes / capacity : 0;
  const state = ratio < 0.4 ? 'light' : ratio <= 1 ? 'balanced' : ratio <= 1.3 ? 'heavy' : 'overloaded';
  return { ratio: Math.round(ratio * 100) / 100, state };
}

/** actual / estimate over a set of finished to-dos, plus how many landed within a quarter of the estimate. */
function estimateSummary(rows) {
  const usable = rows.filter((r) => r.estimate_min > 0 && r.active_s !== null && r.active_s !== undefined);
  if (!usable.length) return { count: 0, ratio: null, within: null };
  const est = usable.reduce((s, r) => s + r.estimate_min * 60, 0);
  const act = usable.reduce((s, r) => s + r.active_s, 0);
  const within = usable.filter((r) => Math.abs(r.active_s / (r.estimate_min * 60) - 1) <= 0.25).length;
  return {
    count: usable.length,
    ratio: Math.round((act / est) * 100) / 100,
    within: Math.round((within / usable.length) * 100),
  };
}

/** "Fast" / "Accurate" / "Slower" / "Much slower" for an actual/estimate ratio. */
function estimateVerdict(ratio) {
  if (ratio === null || ratio === undefined) return null;
  if (ratio < 0.75) return 'fast';
  if (ratio <= 1.25) return 'accurate';
  if (ratio <= 1.6) return 'slower';
  return 'much_slower';
}

/** 0..1 for one key result. */
function keyResultProgress(kr) {
  if (kr.kind === 'todos') {
    const total = Number(kr.todos_total) || 0;
    return total ? clamp((Number(kr.todos_done) || 0) / total, 0, 1) : 0;
  }
  const start = Number(kr.start_value);
  const target = Number(kr.target_value);
  const current = Number(kr.current_value);
  if (target === start) return current >= target ? 1 : 0;
  return clamp((current - start) / (target - start), 0, 1);
}

/** Average of the key results, 0..1. */
function goalProgress(keyResults) {
  if (!keyResults.length) return 0;
  return keyResults.reduce((s, kr) => s + keyResultProgress(kr), 0) / keyResults.length;
}

/**
 * Compares progress with how much of the period has passed.
 * 'done' (all key results complete), 'upcoming', 'on_track', 'at_risk', 'behind'.
 */
function goalPace(progress, startsOn, endsOn, today, daysBetween) {
  if (progress >= 1) return 'done';
  if (today < startsOn) return 'upcoming';
  const total = Math.max(1, daysBetween(startsOn, endsOn) + 1);
  const elapsed = clamp(daysBetween(startsOn, today) + 1, 0, total);
  const expected = elapsed / total;
  if (today > endsOn) return 'behind';
  if (expected < 0.05) return 'on_track';
  const pace = progress / expected;
  return pace >= 0.9 ? 'on_track' : pace >= 0.6 ? 'at_risk' : 'behind';
}

module.exports = {
  WORK_DAY_MIN,
  DEFAULT_TASK_MIN,
  WORK_DAYS_AHEAD,
  healthScore,
  healthLevel,
  attentionReasons,
  loadMinutes,
  workloadState,
  estimateSummary,
  estimateVerdict,
  keyResultProgress,
  goalProgress,
  goalPace,
};
