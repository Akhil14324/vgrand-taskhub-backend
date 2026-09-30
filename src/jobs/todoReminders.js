const db = require('../db');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE } = require('../utils/recurrence');

const INTERVAL_MS = 60 * 1000;

/**
 * Remind everyone on a to-do when its due time arrives (due_date + due_time in
 * APP_TIMEZONE). Each occurrence is reminded once; editing the time or rolling a
 * recurring to-do forward clears reminded_at.
 */
async function sendTodoReminders() {
  try {
    const due = await db.query(
      `UPDATE todos t SET reminded_at = NOW()
       WHERE t.is_done = FALSE
         AND t.due_date IS NOT NULL AND t.due_time IS NOT NULL
         AND t.reminded_at IS NULL
         AND ((t.due_date + t.due_time) AT TIME ZONE $1) <= NOW()
         AND ((t.due_date + t.due_time) AT TIME ZONE $1) > NOW() - INTERVAL '6 hours'
       RETURNING t.id, t.title, to_char(t.due_time, 'HH12:MI AM') AS at`,
      [APP_TIMEZONE]
    );
    for (const todo of due.rows) {
      const members = await db.query('SELECT user_id FROM todo_members WHERE todo_id = $1', [todo.id]);
      await notify(members.rows.map((m) => m.user_id), {
        type: 'todo_reminder',
        title: `⏰ Reminder · ${todo.at.replace(/^0/, '')}`,
        body: todo.title,
        data: { todoId: todo.id },
      });
    }
  } catch (err) {
    console.error('[todo-reminders] failed:', err.message);
  }
}

function scheduleTodoReminders() {
  setTimeout(sendTodoReminders, 10 * 1000);
  setInterval(sendTodoReminders, INTERVAL_MS);
}

module.exports = { scheduleTodoReminders, sendTodoReminders };
