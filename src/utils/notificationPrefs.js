// Notification categories and each person's notification settings (users.preferences.notifications).
// The category map mirrors Taskhub-mobile-ai/src/utils/notificationMeta.js.

const CATEGORY_OF = {
  todo_reminder: 'reminders', todo_upcoming: 'reminders', todo_nudge: 'reminders', blocker_nudge: 'reminders',
  task_assigned: 'assignments', todo_assigned: 'assignments', assignment: 'assignments', todo_shared: 'assignments',
  todo_deadline: 'deadlines', todo_deadline_changed: 'deadlines',
  overdue: 'overdue',
  task_completed: 'completed', todo_done: 'completed',
  daily_digest: 'daily', weekly_recap: 'daily', daily_brief: 'daily',
  ai_recommendation: 'ai',
};
// Everything else (comments, mentions, approvals, chat, kudos, ...) is a team update.
const categoryOf = (type) => CATEGORY_OF[type] || 'team';

// Which settings switch gates which category. Categories not listed here are always delivered.
const SWITCH_OF = { reminders: 'reminders', assignments: 'assignments', deadlines: 'deadlines', overdue: 'deadlines', daily: 'daily', ai: 'ai' };

const DEFAULTS = { reminders: true, assignments: true, deadlines: true, daily: true, ai: true, quietEnabled: false, quietStart: 22, quietEnd: 7, delivery: 'all', leads: [1440, 180, 30] };
const LEADS = [1440, 180, 30]; // minutes before a deadline a reminder may go out: 1 day, 3 hours, 30 minutes

const hour = (v) => Number.isInteger(v) && v >= 0 && v <= 23;

/** The clean settings object (every known key, defaults filled in) or null when the value is not an object. */
function cleanNotifPrefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of ['reminders', 'assignments', 'deadlines', 'daily', 'ai', 'quietEnabled']) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  for (const key of ['quietStart', 'quietEnd']) if (hour(value[key])) out[key] = value[key];
  if (Array.isArray(value.leads)) out.leads = LEADS.filter((m) => value.leads.includes(m));
  if (['all', 'in_app'].includes(value.delivery)) out.delivery = value.delivery;
  return out;
}

const settingsOf = (preferences) => ({ ...DEFAULTS, ...cleanNotifPrefs(preferences?.notifications) });

/** Is `h` (0-23) inside the quiet window? The window may cross midnight (22 to 7). */
function inQuietHours(s, h) {
  if (!s.quietEnabled || s.quietStart === s.quietEnd) return false;
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

/**
 * What to do with one notification for one person:
 *  - `{ send: false }`: they switched this category off, so nothing is stored or sent;
 *  - `{ send: true, live, push }`: stored always; `live` (socket, sound, alarm) and `push` (device) are off
 *    during quiet hours, and `push` is also off when they chose in-app delivery only.
 */
function decide(preferences, type, hourNow) {
  const s = settingsOf(preferences);
  const sw = SWITCH_OF[categoryOf(type)];
  if (sw && s[sw] === false) return { send: false };
  const quiet = inQuietHours(s, hourNow);
  return { send: true, live: !quiet, push: !quiet && s.delivery !== 'in_app' };
}

module.exports = { LEADS, CATEGORY_OF, categoryOf, DEFAULTS, cleanNotifPrefs, settingsOf, inQuietHours, decide };
