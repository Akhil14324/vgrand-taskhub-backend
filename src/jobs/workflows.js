const db = require('../db');
const { notify } = require('../utils/notify');
const { todayInAppZone } = require('../utils/recurrence');
const { spawn } = require('../services/workflows');

// Starts each workflow when its day comes: the to-do and its steps are created for the owner, who is told.
// The schedule is claimed with a conditional update first, so two server instances never start it twice.
const INTERVAL_MS = 10 * 60 * 1000;

async function runDue() {
  try {
    const today = todayInAppZone();
    const due = (await db.query(
      `SELECT * FROM workflows WHERE paused = FALSE AND next_run_date <= $1::date ORDER BY next_run_date LIMIT 50`, [today]
    )).rows;
    for (const wf of due) {
      const claim = await db.query(
        `UPDATE workflows SET last_run_at = NOW() WHERE id = $1 AND next_run_date = $2 AND (last_run_at IS NULL OR last_run_at < NOW() - INTERVAL '1 minute') RETURNING id`,
        [wf.id, wf.next_run_date]
      );
      if (!claim.rows.length) continue;
      try {
        const todo = await spawn(wf);
        if (todo) {
          await notify([wf.owner_id], {
            type: 'workflow_started',
            title: `${wf.name} has started`,
            body: `${(wf.steps || []).length} steps are ready${wf.sequential ? ', one at a time' : ''}.`,
            data: { todoId: todo.id },
          });
        }
      } catch (err) {
        console.error(`[workflows] ${wf.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('[workflows] failed:', err.message);
  }
}

function scheduleWorkflows() {
  setTimeout(runDue, 90 * 1000);
  setInterval(runDue, INTERVAL_MS);
}

module.exports = { scheduleWorkflows, runDue };
