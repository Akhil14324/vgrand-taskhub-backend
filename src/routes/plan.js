const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor } = require('../utils/org');
const { listTodos } = require('../services/todoQueries');
const { todayInAppZone, APP_TIMEZONE } = require('../utils/recurrence');
const { DEFAULT_TASK_MIN } = require('../utils/insights');
const { atRisk } = require('../services/risk');

// /api/plan: the morning plan, and the "usually" suggestions for quick add.
const router = express.Router();

const DAY_START = 9 * 60 + 30;
const LUNCH = [13 * 60, 14 * 60];
const DAY_END = 18 * 60 + 30;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const nowMinutes = () => {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: APP_TIMEZONE, hour12: false }).split(':').map(Number);
  return h * 60 + m;
};
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Higher = sooner, with the reason shown to the person. */
function rank(t, today) {
  let score = 0;
  let why = 'Next on your list';
  if (t.deadline_date && t.deadline_date <= today) { score += 36; why = t.deadline_date < today ? 'Past its deadline' : 'Deadline is today'; }
  if (t.due_date && t.due_date < today) { score += 40; why = 'Overdue'; }
  else if (t.due_date === today) { score += 25; if (why === 'Next on your list') why = 'Due today'; }
  score += (4 - (t.priority || 4)) * 6;
  if (t.priority === 1 && why === 'Next on your list') why = 'Top priority';
  if (t.status === 'in_progress') { score += 8; if (why === 'Next on your list') why = 'Already in progress'; }
  return { score, why };
}

// GET /api/plan — today's work in order, laid out in time blocks that fit the working day.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const today = todayInAppZone();
    const rows = await listTodos(req.user.id, {
      actor,
      where: `t.is_done = FALSE AND t.status <> 'blocked' AND t.review_state = 'accepted'
        AND (t.assignee_id = $1 OR (t.business_id IS NULL AND tm.user_id IS NOT NULL))
        AND (t.due_date <= $5::date OR t.deadline_date <= $5::date OR t.status = 'in_progress' OR t.priority = 1)
        AND NOT EXISTS (SELECT 1 FROM todos c WHERE c.parent_id = t.id AND c.is_done = FALSE)`,
      params: [today],
    });
    const ranked = rows
      .map((t) => ({ t, ...rank(t, today) }))
      .sort((a, b) => b.score - a.score || (a.t.due_time || '99').localeCompare(b.t.due_time || '99'));

    let cursor = Math.max(DAY_START, Math.ceil(nowMinutes() / 15) * 15);
    const plan = [];
    const overflow = [];
    for (const { t, why } of ranked) {
      const minutes = t.duration_minutes || DEFAULT_TASK_MIN;
      if (cursor < LUNCH[1] && cursor + minutes > LUNCH[0] && cursor >= LUNCH[0] - 15) cursor = LUNCH[1];
      if (cursor >= LUNCH[0] && cursor < LUNCH[1]) cursor = LUNCH[1];
      const item = { id: t.id, title: t.title, why, minutes, priority: t.priority, due_date: t.due_date, business_name: t.business_name || null };
      if (cursor + minutes > DAY_END) { overflow.push(item); continue; }
      plan.push({ ...item, start: hhmm(cursor), end: hhmm(cursor + minutes) });
      cursor += minutes;
    }
    const planned = plan.reduce((s, p) => s + p.minutes, 0);
    res.json({
      today,
      plan,
      overflow,
      planned_minutes: planned,
      note: overflow.length
        ? `${overflow.length} more will not fit today. Move them or ask for help.`
        : plan.length ? `About ${Math.round(planned / 6) / 10} hours of work, it fits the day.` : 'Nothing is due. A good day to plan ahead.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/plan/defaults — who this person usually gives work to and which business they usually add to.
router.get('/defaults', authenticate, async (req, res, next) => {
  try {
    const people = (await db.query(
      `SELECT u.id, u.name, u.username, u.profile_picture, COUNT(*)::int AS n
       FROM todos t JOIN users u ON u.id = t.assignee_id
       WHERE t.created_by = $1 AND t.assignee_id <> $1 AND t.parent_id IS NULL AND t.created_at > NOW() - INTERVAL '60 days'
         AND u.status <> 'inactive'
       GROUP BY u.id ORDER BY n DESC, u.name LIMIT 4`,
      [req.user.id]
    )).rows;
    const biz = (await db.query(
      `SELECT b.id, b.name, COUNT(*)::int AS n FROM todos t JOIN businesses b ON b.id = t.business_id
       WHERE t.created_by = $1 AND t.parent_id IS NULL AND t.created_at > NOW() - INTERVAL '60 days'
       GROUP BY b.id ORDER BY n DESC LIMIT 1`,
      [req.user.id]
    )).rows[0] || null;
    res.json({ assignees: people, business: biz });
  } catch (err) {
    next(err);
  }
});

// GET /api/plan/risk — to-dos in the next week that look likely to miss their date, with the reasons.
router.get('/risk', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    res.json({ items: await atRisk(actor) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
