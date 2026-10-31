const db = require('../db');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { statusOf } = require('../utils/timebox');

// Company timezone. Morning: plan the day if nothing is written yet. Evening: fill it in and send it.
const MORNING_FROM = 8;
const MORNING_UNTIL = 12;
const EVENING_FROM = 20;

const INTERVAL_MS = 5 * 60 * 1000;

const hourNow = async () => (await db.query('SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h', [APP_TIMEZONE])).rows[0].h;

/** Everyone who works here (not the owner account, not people who were deactivated, not on a rest day). */
async function people(today) {
  return (await db.query(
    `SELECT u.id, t.priorities, t.brain_dump, t.blocks, t.reflection, t.submitted_at
     FROM users u
     LEFT JOIN timeboxes t ON t.user_id = u.id AND t.box_date = $1::date
     WHERE u.status <> 'inactive' AND u.username <> 'owner'
       AND NOT EXISTS (SELECT 1 FROM streak_rests r WHERE r.user_id = u.id AND r.day = $1::date)`,
    [today]
  )).rows;
}

const claim = async (userId, day, kind) => (await db.query(
  'INSERT INTO timebox_nudges (user_id, day, kind) VALUES ($1, $2::date, $3) ON CONFLICT DO NOTHING RETURNING user_id', [userId, day, kind]
)).rows.length > 0;

async function sendTimeboxReminders(hourOverride) {
  const hour = Number.isInteger(hourOverride) ? hourOverride : await hourNow();
  const morning = hour >= MORNING_FROM && hour < MORNING_UNTIL;
  const evening = hour >= EVENING_FROM;
  if (!morning && !evening) return;
  const today = todayInAppZone();
  for (const p of await people(today)) {
    const status = statusOf(p.priorities ? p : null); // no box row: priorities is NULL from the LEFT JOIN
    if (morning && status === 'none' && (await claim(p.id, today, 'morning'))) {
      await notify([p.id], {
        type: 'timebox',
        title: 'Plan your day',
        body: 'Start with your timebox: your top three and the blocks for each.',
        data: { type: 'timebox', screen: 'Timebox', date: today },
      });
    }
    if (evening && status !== 'sent' && (await claim(p.id, today, 'evening'))) {
      await notify([p.id], {
        type: 'timebox',
        title: status === 'none' ? 'Fill in your timebox' : 'Send your timebox',
        body: status === 'none'
          ? 'Write what you worked on today, mark what got done and send it.'
          : 'Mark the blocks you finished, add a line about the day and send it.',
        data: { type: 'timebox', screen: 'Timebox', date: today },
      });
    }
  }
}

async function runTimeboxJob() {
  try {
    await sendTimeboxReminders();
  } catch (err) {
    console.error('[timebox] failed:', err.message);
  }
}

function scheduleTimebox() {
  setTimeout(runTimeboxJob, 45 * 1000);
  setInterval(runTimeboxJob, INTERVAL_MS);
}

module.exports = { scheduleTimebox, runTimeboxJob, sendTimeboxReminders };
