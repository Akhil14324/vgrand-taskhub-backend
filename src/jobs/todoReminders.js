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

    await sendEarlyReminders();
  } catch (err) {
    console.error('[todo-reminders] failed:', err.message);
  }
}

function describeOffset(minutes) {
  if (minutes >= 1440) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes >= 60) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} min`;
}

/**
 * Extra reminders ("30 min before"): each offset fires once per due time. The UPDATE guard
 * makes sure only one server instance sends it.
 */
async function sendEarlyReminders() {
  const candidates = await db.query(
    `SELECT t.id, t.title, o AS minutes, to_char(t.due_time, 'HH12:MI AM') AS at
     FROM todos t, unnest(t.reminder_offsets) AS o
     WHERE t.is_done = FALSE
       AND t.due_date IS NOT NULL AND t.due_time IS NOT NULL
       AND NOT (o = ANY(t.reminders_sent))
       AND ((t.due_date + t.due_time) AT TIME ZONE $1) - make_interval(mins => o) <= NOW()
       AND ((t.due_date + t.due_time) AT TIME ZONE $1) > NOW()`,
    [APP_TIMEZONE]
  );
  for (const row of candidates.rows) {
    const claimed = await db.query(
      `UPDATE todos SET reminders_sent = array_append(reminders_sent, $2::int)
       WHERE id = $1 AND NOT ($2::int = ANY(reminders_sent)) RETURNING id`,
      [row.id, row.minutes]
    );
    if (!claimed.rows.length) continue;
    const members = await db.query('SELECT user_id FROM todo_members WHERE todo_id = $1', [row.id]);
    await notify(members.rows.map((m) => m.user_id), {
      type: 'todo_reminder',
      title: `⏰ In ${describeOffset(row.minutes)} · ${row.at.replace(/^0/, '')}`,
      body: row.title,
      data: { todoId: row.id },
    });
  }
}

function scheduleTodoReminders() {
  setTimeout(sendTodoReminders, 10 * 1000);
  setInterval(sendTodoReminders, INTERVAL_MS);
}

module.exports = { scheduleTodoReminders, sendTodoReminders };
