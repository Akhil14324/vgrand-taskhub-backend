// Business day boundaries and reminders use the company's timezone, not the server's.
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

/** Today's date in APP_TIMEZONE as 'YYYY-MM-DD'. */
function todayInAppZone(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function toUtcDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

function advance(ymd, recurrence) {
  const d = toUtcDate(ymd);
  switch (recurrence) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'weekdays':
      do {
        d.setUTCDate(d.getUTCDate() + 1);
      } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'monthly': {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
      break;
    }
    default:
      d.setUTCDate(d.getUTCDate() + 1);
  }
  return toYmd(d);
}

/**
 * Next due date for a recurring to-do that was just completed: always after today,
 * so finishing an overdue daily item schedules it for tomorrow, not for a past day.
 */
function nextOccurrence(dueYmd, recurrence, todayYmd = todayInAppZone()) {
  let next = advance(dueYmd, recurrence);
  let guard = 0;
  while (next <= todayYmd && guard < 1000) {
    next = advance(next, recurrence);
    guard += 1;
  }
  return next;
}

module.exports = { APP_TIMEZONE, todayInAppZone, nextOccurrence, advance };
