const db = require('../db');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE } = require('../utils/recurrence');
const { openProcesses, STALL_DAYS } = require('../services/processes');
const { monitorablePeople, actorCanMonitor } = require('../services/monitor');
const { loadActor } = require('../utils/org');

// A task made of steps that has had no step finished for a few days, while its date comes close, is reported once
// (then again after three more days if it is still stuck) to whoever owns it and to the people who watch them.
// See services/processes.js for what "stalled" means.
const FROM_HOUR = 9;
const TO_HOUR = 11;
const INTERVAL_MS = 60 * 60 * 1000;

/** viewer id -> Set of people they may watch, for everyone who may monitor at all. Built once per run. */
async function watchMap() {
  const ids = (await db.query(`SELECT id FROM users WHERE status != 'inactive'`)).rows.map((r) => r.id);
  const map = new Map();
  for (const id of ids) {
    const actor = await loadActor(id);
    if (!actorCanMonitor(actor)) continue;
    const { people } = await monitorablePeople(id);
    map.set(id, new Set(people.map((p) => p.id)));
  }
  return map;
}

async function run({ force = false } = {}) {
  try {
    if (!force) {
      const hour = (await db.query('SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE $1)::int AS h', [APP_TIMEZONE])).rows[0].h;
      if (hour < FROM_HOUR || hour >= TO_HOUR) return 0;
    }
    const stalled = (await openProcesses()).filter((p) => p.stalled);
    if (!stalled.length) return 0;
    const watchers = await watchMap();
    let sent = 0;
    for (const p of stalled) {
      const claimed = await db.query(
        `INSERT INTO process_alerts (todo_id) VALUES ($1)
         ON CONFLICT (todo_id) DO UPDATE SET alerted_at = NOW() WHERE process_alerts.alerted_at < NOW() - make_interval(days => $2)
         RETURNING todo_id`,
        [p.id, STALL_DAYS]
      );
      if (!claimed.rows.length) continue;
      const when = p.daysToDue === null || p.daysToDue === undefined ? '' : p.daysToDue < 0 ? ` It is ${-p.daysToDue} day${p.daysToDue === -1 ? '' : 's'} late.` : p.daysToDue === 0 ? ' It is due today.' : ` It is due in ${p.daysToDue} day${p.daysToDue === 1 ? '' : 's'}.`;
      const body = `${p.title}: ${p.done} of ${p.total} steps done, nothing finished for ${p.idleDays} days.${when}`;
      await notify([p.assignee_id], { type: 'process_stalled', title: 'Nothing finished lately', body, data: { todoId: p.id } });
      const above = [...watchers.entries()].filter(([viewer, people]) => viewer !== p.assignee_id && people.has(p.assignee_id)).map(([viewer]) => viewer);
      if (above.length) {
        const who = (await db.query('SELECT name FROM users WHERE id = $1', [p.assignee_id])).rows[0]?.name || 'Someone';
        await notify(above, { type: 'process_stalled', title: `${who}'s task has stalled`, body, data: { todoId: p.id } });
      }
      sent += 1;
    }
    return sent;
  } catch (err) {
    console.error('[processAlerts] failed:', err.message);
    return 0;
  }
}

function scheduleProcessAlerts() {
  setTimeout(run, 6 * 60 * 1000);
  setInterval(run, INTERVAL_MS);
}

module.exports = { scheduleProcessAlerts, run };
