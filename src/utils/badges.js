/**
 * Milestone badges, worked out from a few numbers so the rules can be tested without a database.
 * Each family has tiers; a badge is earned once the person's value reaches the tier's target.
 */

const FAMILIES = [
  {
    family: 'tasks',
    icon: 'ribbon',
    tiers: [1, 10, 50, 100, 250, 500, 1000],
    value: (s) => s.total,
    title: (n) => (n === 1 ? 'First finish' : `${n} tasks done`),
    description: (n) => (n === 1 ? 'Finish your first task' : `Finish ${n} tasks`),
  },
  {
    family: 'streak',
    icon: 'flame',
    tiers: [3, 7, 14, 30, 60, 100],
    value: (s) => s.longestStreak,
    title: (n) => `${n}-day streak`,
    description: (n) => `Finish something ${n} working days in a row`,
  },
  {
    family: 'clean_month',
    icon: 'time',
    tiers: [1, 3, 6, 12],
    value: (s) => s.cleanMonths,
    title: (n) => (n === 1 ? 'Zero-late month' : `${n} zero-late months`),
    description: (n) => (n === 1 ? 'A full month, at least 5 tasks, none finished late' : `${n} months with nothing finished late`),
  },
  {
    family: 'kudos',
    icon: 'heart',
    tiers: [1, 10, 50],
    value: (s) => s.kudos,
    title: (n) => (n === 1 ? 'First kudos' : `${n} kudos received`),
    description: (n) => (n === 1 ? 'A colleague said thanks' : `Colleagues thanked you ${n} times`),
  },
];

/** A month counts as "zero late" when it is over, had at least `minDone` finishes and none were late. */
function countCleanMonths(months, currentMonth, minDone = 5) {
  return (months || []).filter((m) => m.month < currentMonth && m.done >= minDone && m.late === 0).length;
}

/** stats: { total, longestStreak, cleanMonths, kudos } -> every badge with earned / progress. */
function computeBadges(stats) {
  const out = [];
  for (const fam of FAMILIES) {
    const have = Number(fam.value(stats)) || 0;
    fam.tiers.forEach((target, i) => {
      out.push({
        key: `${fam.family}_${target}`,
        family: fam.family,
        tier: i + 1,
        tiers: fam.tiers.length,
        icon: fam.icon,
        title: fam.title(target),
        description: fam.description(target),
        target,
        progress: Math.min(have, target),
        earned: have >= target,
      });
    });
  }
  return out;
}

module.exports = { FAMILIES, countCleanMonths, computeBadges };
