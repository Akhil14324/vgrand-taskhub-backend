const db = require('../db');
const { formatOverdueMessage } = require('../utils/dates');
const { notify } = require('../utils/notify');
const { levelWithDesignation } = require('../utils/org');

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

function delayUntilMidnight() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  return nextMidnight - now;
}

async function sendOverdueNotifications() {
  try {
    // Tasks that are overdue (due date is in the past), not completed, not on hold,
    // and have not already received an overdue notification.
    // CURRENT_DATE is evaluated in Postgres's session timezone; this assumes the DB
    // server and the application agree on what "today" is.
    const overdueTasks = await db.query(
      `SELECT t.id, t.title, t.due_date, t.assigned_user_id, t.business_id, t.created_by,
              b.name AS business_name
       FROM tasks t
       JOIN businesses b ON b.id = t.business_id
       WHERE t.due_date < CURRENT_DATE
         AND t.status NOT IN ('completed', 'on_hold', 'in_review')
         AND t.last_overdue_notification_at IS NULL`
    );

    if (overdueTasks.rows.length === 0) {
      console.log('[overdue] No overdue tasks to notify about.');
      return;
    }

    console.log(`[overdue] Notifying for ${overdueTasks.rows.length} overdue task(s).`);

    const leaders = await db.query(
      `SELECT id FROM users WHERE role IN ('super_admin', 'admin') AND status != 'inactive'`
    );
    const leaderIds = leaders.rows.map((r) => r.id);

    for (const task of overdueTasks.rows) {
      const message = formatOverdueMessage(task);
      const data = { taskId: task.id };

      // People who have to act: the assignee (or the whole business if unassigned),
      // whoever raised it, and the business heads/managers.
      const members = await db.query(
        `SELECT u.id, u.role, u.org_level, ub.designation FROM users u
         JOIN user_businesses ub ON ub.user_id = u.id
         WHERE ub.business_id = $1 AND u.status != 'inactive'`,
        [task.business_id]
      );
      const managers = members.rows.filter((m) => levelWithDesignation(m, m.designation) <= 5).map((m) => m.id);
      const doers = task.assigned_user_id ? [task.assigned_user_id] : members.rows.map((m) => m.id);
      const actNow = [...new Set([...doers, task.created_by, ...managers])];

      await notify(actNow, { type: 'overdue', title: '⏰ Task overdue', body: message, data });
      // Leadership sees it in their feed without a buzz for every task.
      await notify(leaderIds, { type: 'overdue', title: '⏰ Task overdue', body: message, data }, { push: false, exclude: actNow });

      // Mark task as notified
      await db.query(
        `UPDATE tasks SET last_overdue_notification_at = NOW() WHERE id = $1`,
        [task.id]
      );
    }
  } catch (err) {
    console.error('[overdue] Error sending overdue notifications:', err.message);
  }
}

function scheduleOverdueNotifications() {
  // Run once shortly after startup to cover missed days
  setTimeout(() => {
    sendOverdueNotifications();

    // Schedule the next run at midnight, then recursively every 24h
    const scheduleNext = () => {
      const delay = delayUntilMidnight();
      setTimeout(() => {
        sendOverdueNotifications();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }, 5000);
}

module.exports = { scheduleOverdueNotifications, sendOverdueNotifications };
