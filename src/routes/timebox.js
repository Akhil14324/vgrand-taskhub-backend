const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { monitorablePeople } = require('../services/monitor');
const { todayInAppZone } = require('../utils/recurrence');
const { emitToUsers } = require('../utils/notify');
const { cleanBox, statusOf, summarize, editable, sendProblem } = require('../utils/timebox');

/**
 * /api/timebox: the Timebox planner (migration 058). One box per person per day.
 *   GET  /day/:date?user_id=     a box (mine, or a sent one of someone below me)
 *   PUT  /day/:date              { priorities, brain_dump, blocks, reflection }  save my box (not once it is sent)
 *   POST /day/:date/send         send it: locked, and now readable by the people above me
 *   GET  /days?user_id=&from=&to= the status of each day in a range (the date strip)
 *   GET  /team?date=             everyone below me: who planned, who sent, and the numbers
 * "Above" is the Team monitor's rule (services/monitor.js): leadership sees everyone below them, a business head the
 * people below them in the businesses they head. A box nobody has sent shows only its status, never its contents.
 */
const router = express.Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = (v) => (Number.isInteger(v) ? v : parseInt(v, 10) || null);

function dateParam(req, res) {
  const d = String(req.params.date || req.query.date || '');
  if (d === 'today' || !d) return todayInAppZone();
  if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) { res.status(400).json({ error: 'Use a date like 2026-10-31' }); return null; }
  return d;
}

const loadBox = async (userId, date) => (await db.query('SELECT * FROM timeboxes WHERE user_id = $1 AND box_date = $2::date', [userId, date])).rows[0] || null;

const seenBy = async (boxId) => (await db.query(
  `SELECT v.viewer_id AS id, u.name, u.profile_picture, v.seen_at FROM timebox_views v JOIN users u ON u.id = v.viewer_id
   WHERE v.timebox_id = $1 ORDER BY v.seen_at`, [boxId]
)).rows;

/** The person `targetId` if the viewer sits above them, else null. */
async function below(viewerId, targetId) {
  const { people } = await monitorablePeople(viewerId);
  return people.find((p) => p.id === targetId) || null;
}

/** People who sit above `userId` (who can read their sent box). */
async function above(userId) {
  const rows = (await db.query("SELECT id FROM users WHERE status <> 'inactive' AND id <> $1", [userId])).rows;
  const out = [];
  for (const { id } of rows) {
    const { people } = await monitorablePeople(id);
    if (people.some((p) => p.id === userId)) out.push(id);
  }
  return out;
}

function shape(row, date, today, { mine }) {
  const empty = { priorities: [], brain_dump: [], blocks: [], reflection: '' };
  const box = row ? { priorities: row.priorities, brain_dump: row.brain_dump, blocks: row.blocks, reflection: row.reflection } : empty;
  return {
    date,
    status: statusOf(row),
    submitted_at: row?.submitted_at || null,
    updated_at: row?.updated_at || null,
    can_edit: mine && editable(date, today, row),
    can_send: mine && !sendProblem(date, today, row),
    summary: summarize(row),
    box,
  };
}

router.get('/day/:date', authenticate, async (req, res, next) => {
  try {
    const date = dateParam(req, res);
    if (!date) return;
    const today = todayInAppZone();
    const targetId = int(req.query.user_id) || req.user.id;
    if (targetId === req.user.id) {
      const row = await loadBox(req.user.id, date);
      return res.json({ ...shape(row, date, today, { mine: true }), mine: true, seen_by: row?.submitted_at ? await seenBy(row.id) : [] });
    }
    const person = await below(req.user.id, targetId);
    if (!person) return res.status(404).json({ error: 'You can only see the timeboxes of people below you' });
    const row = await loadBox(targetId, date);
    const out = shape(row, date, today, { mine: false });
    if (!row?.submitted_at) return res.json({ ...out, mine: false, person, box: null, summary: null });
    await db.query('INSERT INTO timebox_views (timebox_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, req.user.id]);
    res.json({ ...out, mine: false, person });
  } catch (err) {
    next(err);
  }
});

router.put('/day/:date', authenticate, async (req, res, next) => {
  try {
    const date = dateParam(req, res);
    if (!date) return;
    const today = todayInAppZone();
    const existing = await loadBox(req.user.id, date);
    if (existing?.submitted_at) return res.status(409).json({ error: 'This timebox was sent, so it cannot be changed' });
    if (!editable(date, today, existing)) return res.status(400).json({ error: 'You can plan from yesterday to two weeks ahead' });
    const { box, errors } = cleanBox(req.body || {});
    const row = (await db.query(
      `INSERT INTO timeboxes (user_id, box_date, priorities, brain_dump, blocks, reflection)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (user_id, box_date) DO UPDATE
         SET priorities = EXCLUDED.priorities, brain_dump = EXCLUDED.brain_dump, blocks = EXCLUDED.blocks,
             reflection = EXCLUDED.reflection, updated_at = NOW()
         WHERE timeboxes.submitted_at IS NULL
       RETURNING *`,
      [req.user.id, date, JSON.stringify(box.priorities), JSON.stringify(box.brain_dump), JSON.stringify(box.blocks), box.reflection]
    )).rows[0];
    if (!row) return res.status(409).json({ error: 'This timebox was sent, so it cannot be changed' });
    emitToUsers([req.user.id], 'timebox:changed', { date });
    res.json({ ...shape(row, date, today, { mine: true }), mine: true, seen_by: [], warnings: errors });
  } catch (err) {
    next(err);
  }
});

router.post('/day/:date/send', authenticate, async (req, res, next) => {
  try {
    const date = dateParam(req, res);
    if (!date) return;
    const today = todayInAppZone();
    const existing = await loadBox(req.user.id, date);
    const problem = sendProblem(date, today, existing);
    if (problem) return res.status(400).json({ error: problem });
    const row = (await db.query(
      'UPDATE timeboxes SET submitted_at = NOW(), updated_at = NOW() WHERE id = $1 AND submitted_at IS NULL RETURNING *', [existing.id]
    )).rows[0];
    if (!row) return res.status(409).json({ error: 'Already sent' });
    emitToUsers([req.user.id], 'timebox:changed', { date });
    // The people above see it arrive in their Team list (no notification: forty boxes a night would be noise).
    above(req.user.id).then((ids) => emitToUsers(ids, 'timebox:changed', { date, user_id: req.user.id })).catch(() => {});
    res.json({ ...shape(row, date, today, { mine: true }), mine: true, seen_by: [] });
  } catch (err) {
    next(err);
  }
});

router.get('/days', authenticate, async (req, res, next) => {
  try {
    const today = todayInAppZone();
    const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const from = DATE.test(req.query.from || '') ? req.query.from : shift(today, -13);
    const to = DATE.test(req.query.to || '') ? req.query.to : shift(today, 1);
    if (from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 62 * 86400000) return res.status(400).json({ error: 'Ask for at most two months' });
    const targetId = int(req.query.user_id) || req.user.id;
    if (targetId !== req.user.id && !(await below(req.user.id, targetId))) return res.status(404).json({ error: 'You can only see the timeboxes of people below you' });
    const rows = (await db.query('SELECT * FROM timeboxes WHERE user_id = $1 AND box_date BETWEEN $2::date AND $3::date', [targetId, from, to])).rows;
    const byDate = new Map(rows.map((r) => [r.box_date, r]));
    const days = [];
    for (let d = from; d <= to; d = shift(d, 1)) {
      const s = summarize(byDate.get(d));
      days.push({ date: d, status: s.status, percent: s.percent });
    }
    res.json({ today, days });
  } catch (err) {
    next(err);
  }
});

router.get('/team', authenticate, async (req, res, next) => {
  try {
    const date = dateParam(req, res);
    if (!date) return;
    const { people } = await monitorablePeople(req.user.id);
    if (!people.length) return res.json({ date, people: [], counts: { sent: 0, planned: 0, none: 0 } });
    const rows = (await db.query('SELECT * FROM timeboxes WHERE box_date = $1::date AND user_id = ANY($2::int[])', [date, people.map((p) => p.id)])).rows;
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    const list = people.map((p) => {
      const row = byUser.get(p.id);
      const s = summarize(row);
      // Before it is sent only the status shows; the numbers are part of the contents.
      return {
        id: p.id, name: p.name, profile_picture: p.profile_picture, display_title: p.display_title, businesses: p.businesses, business_ids: p.business_ids,
        status: s.status, submitted_at: row?.submitted_at || null,
        summary: row?.submitted_at ? s : null,
        top: row?.submitted_at ? (row.priorities || []).map((x) => x.text) : [],
      };
    });
    const counts = { sent: 0, planned: 0, none: 0 };
    for (const p of list) counts[p.status] += 1;
    res.json({ date, people: list, counts });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
