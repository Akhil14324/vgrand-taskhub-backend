const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { todayInAppZone } = require('../utils/recurrence');
const { shift } = require('../utils/streak');
const { streakFor, waitingOnUser, weekStart, weekStats } = require('../services/engagement');
const { badgesFor, weekWall } = require('../services/wins');
const { loadActor } = require('../utils/org');
const { leaderboardFor, PERIODS } = require('../services/leaderboard');

const router = express.Router();

const REASONS = {
  great_work: 'Great work',
  above_and_beyond: 'Above and beyond',
  team_player: 'Team player',
  fast: 'Lightning fast',
  problem_solver: 'Problem solver',
  helpful: 'Thanks for the help',
};
const KUDOS_PER_DAY = 10;
const RESTS_PER_30_DAYS = 4;

// GET /api/engage/myday — streak, day-complete state and what people are waiting on this person for
router.get('/myday', authenticate, async (req, res, next) => {
  try {
    const [streak, waiting, received] = await Promise.all([
      streakFor(req.user.id),
      waitingOnUser(req.user.id),
      db.query(
        `SELECT COUNT(*)::int AS n FROM kudos WHERE to_user_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
        [req.user.id]
      ),
    ]);
    res.json({ ...streak, waiting_on_you: waiting, kudos_this_week: received.rows[0].n });
  } catch (err) {
    next(err);
  }
});

// GET /api/engage/leaderboard?period=week|month|quarter|all&business_id= — who finished what, with streaks
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const period = Object.prototype.hasOwnProperty.call(PERIODS, req.query.period) ? req.query.period : 'week';
    const businessId = parseInt(req.query.business_id, 10) || null;
    res.json(await leaderboardFor(actor, { period, businessId }));
  } catch (err) {
    next(err);
  }
});

// POST /api/engage/rest — take today as a rest day (it never breaks the streak). DELETE undoes it.
router.post('/rest', authenticate, async (req, res, next) => {
  try {
    const today = todayInAppZone();
    const used = await db.query(
      `SELECT COUNT(*)::int AS n FROM streak_rests WHERE user_id = $1 AND day > $2::date - 30 AND day <> $2::date`,
      [req.user.id, today]
    );
    if (used.rows[0].n >= RESTS_PER_30_DAYS) {
      return res.status(400).json({ error: `You can rest ${RESTS_PER_30_DAYS} days in 30 (weekends are free)` });
    }
    await db.query(`INSERT INTO streak_rests (user_id, day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`, [req.user.id, today]);
    res.json(await streakFor(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/rest', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM streak_rests WHERE user_id = $1 AND day = $2::date', [req.user.id, todayInAppZone()]);
    res.json(await streakFor(req.user.id));
  } catch (err) {
    next(err);
  }
});

// GET /api/engage/recap?week=0|1|2 — this person's week next to the one before it (0 = this week so far)
router.get('/recap', authenticate, async (req, res, next) => {
  try {
    const offset = Math.min(8, Math.max(0, parseInt(req.query.week, 10) || 0));
    const start = await weekStart(offset);
    const [current, previous, streak] = await Promise.all([
      weekStats(req.user.id, start),
      weekStats(req.user.id, shift(start, -7)),
      streakFor(req.user.id),
    ]);
    res.json({ offset, current, previous, streak: streak.streak, longest_streak: streak.longest_streak, today: streak.today });
  } catch (err) {
    next(err);
  }
});

// POST /api/engage/kudos — { to_user_id, todo_id?, reason?, message? }
router.post('/kudos', authenticate, async (req, res, next) => {
  try {
    const toId = parseInt(req.body.to_user_id, 10);
    if (!toId || toId === req.user.id) return res.status(400).json({ error: 'Pick a colleague to thank' });
    const reason = REASONS[req.body.reason] ? req.body.reason : 'great_work';
    const message = sanitizeText(req.body.message, 280);
    const todoId = parseInt(req.body.todo_id, 10) || null;

    const [target, sent] = await Promise.all([
      db.query(`SELECT id, name FROM users WHERE id = $1 AND status <> 'inactive'`, [toId]),
      db.query(`SELECT COUNT(*)::int AS n FROM kudos WHERE from_user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [req.user.id]),
    ]);
    if (!target.rows.length) return res.status(404).json({ error: 'That person is not available' });
    if (sent.rows[0].n >= KUDOS_PER_DAY) return res.status(429).json({ error: `You can send ${KUDOS_PER_DAY} kudos a day` });
    if (todoId) {
      const exists = await db.query('SELECT 1 FROM todos WHERE id = $1', [todoId]);
      if (!exists.rows.length) return res.status(404).json({ error: 'That to-do no longer exists' });
    }

    const row = (await db.query(
      `INSERT INTO kudos (from_user_id, to_user_id, todo_id, reason, message) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, reason, message, created_at`,
      [req.user.id, toId, todoId, reason, message]
    )).rows[0];

    const me = (await db.query('SELECT name FROM users WHERE id = $1', [req.user.id])).rows[0];
    await notify([toId], {
      type: 'kudos',
      title: `${me.name} sent you kudos`,
      body: `${REASONS[reason]}${message ? `: ${message}` : ''}`,
      data: { type: 'kudos', kudosId: row.id, ...(todoId ? { todoId } : {}) },
    });
    emitToUsers([toId], 'kudos:new', { id: row.id });
    res.status(201).json({ ...row, remaining_today: KUDOS_PER_DAY - sent.rows[0].n - 1 });
  } catch (err) {
    next(err);
  }
});

// GET /api/engage/kudos?scope=received|given|company&limit=
// The company wall is visible to everyone; a to-do title is shown only to the two people involved.
router.get('/kudos', authenticate, async (req, res, next) => {
  try {
    const scope = ['received', 'given', 'company'].includes(req.query.scope) ? req.query.scope : 'company';
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const where = scope === 'received' ? 'k.to_user_id = $1' : scope === 'given' ? 'k.from_user_id = $1' : 'TRUE';
    const result = await db.query(
      `SELECT k.id, k.reason, k.message, k.created_at, k.todo_id,
              CASE WHEN k.from_user_id = $1 OR k.to_user_id = $1 THEN t.title END AS todo_title,
              f.id AS from_id, f.name AS from_name, f.profile_picture AS from_picture, f.org_level AS from_level,
              r.id AS to_id, r.name AS to_name, r.profile_picture AS to_picture
       FROM kudos k
       JOIN users f ON f.id = k.from_user_id
       JOIN users r ON r.id = k.to_user_id
       LEFT JOIN todos t ON t.id = k.todo_id
       WHERE ${where}
       ORDER BY k.created_at DESC LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ reasons: REASONS, kudos: result.rows.map((k) => ({ ...k, from_leadership: !!k.from_level && k.from_level <= 3 })) });
  } catch (err) {
    next(err);
  }
});

// GET /api/engage/badges — my milestone badges and the numbers behind them
router.get('/badges', authenticate, async (req, res, next) => {
  try {
    res.json(await badgesFor(req.user.id));
  } catch (err) {
    next(err);
  }
});

// GET /api/engage/wall?week=0 — what the company finished this week (week=1 is last week)
router.get('/wall', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor) return res.status(401).json({ error: 'User no longer exists' });
    const week = Math.min(12, Math.max(0, parseInt(req.query.week, 10) || 0));
    res.json(await weekWall(actor, week));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
