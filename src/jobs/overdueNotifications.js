const db = require('../db');

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
    const overdueTasks = await db.query(
      `SELECT t.id, t.title, t.due_date, t.assigned_user_id, t.business_id,
              b.name AS business_name
       FROM tasks t
       JOIN businesses b ON b.id = t.business_id
       WHERE t.due_date < CURRENT_DATE
         AND t.status != 'completed'
         AND t.status != 'on_hold'
         AND t.last_overdue_notification_at IS NULL`
    );

    if (overdueTasks.rows.length === 0) {
      console.log('[overdue] No overdue tasks to notify about.');
      return;
    }

    console.log(`[overdue] Notifying for ${overdueTasks.rows.length} overdue task(s).`);

    const admins = await db.query(
      `SELECT id, role FROM users WHERE role IN ('super_admin', 'admin') AND status = 'active'`
    );

    for (const task of overdueTasks.rows) {
      const message = `Task "${task.title}" (${task.business_name}) is overdue. Due date was ${task.due_date}.`;
      const notified = new Set();

      // Notify the assigned user (primary user to notify)
      if (task.assigned_user_id) {
        await db.query(
          `INSERT INTO notifications (user_id, type, message) VALUES ($1, 'overdue', $2)`,
          [task.assigned_user_id, message]
        );
        notified.add(task.assigned_user_id);
      }

      // Notify all active super_admins and admins
      for (const admin of admins.rows) {
        if (notified.has(admin.id)) continue;
        await db.query(
          `INSERT INTO notifications (user_id, type, message) VALUES ($1, 'overdue', $2)`,
          [admin.id, message]
        );
        notified.add(admin.id);
      }

      // If no specific user is assigned, also notify regular users linked to the business
      if (!task.assigned_user_id) {
        const bizUsers = await db.query(
          `SELECT u.id FROM users u
           JOIN user_businesses ub ON ub.user_id = u.id
           WHERE ub.business_id = $1 AND u.role = 'user' AND u.status = 'active'`,
          [task.business_id]
        );
        for (const u of bizUsers.rows) {
          if (notified.has(u.id)) continue;
          await db.query(
            `INSERT INTO notifications (user_id, type, message) VALUES ($1, 'overdue', $2)`,
            [u.id, message]
          );
          notified.add(u.id);
        }
      }

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
  // Run once shortly after startup to cover missed days, then daily at midnight
  setTimeout(() => {
    sendOverdueNotifications();
    setInterval(sendOverdueNotifications, TWENTY_FOUR_HOURS);
  }, 5000);

  // Also schedule the recurring midnight run
  const midnightDelay = delayUntilMidnight();
  setTimeout(() => {
    sendOverdueNotifications();
    setInterval(sendOverdueNotifications, TWENTY_FOUR_HOURS);
  }, midnightDelay);
}

module.exports = { scheduleOverdueNotifications, sendOverdueNotifications };
