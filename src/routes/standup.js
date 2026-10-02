const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify } = require('../utils/notify');
const { APP_TIMEZONE, todayInAppZone } = require('../utils/recurrence');
const { loadActor, nextApprovers, actorLevelIn } = require('../utils/org');
const { monitorablePeople } = require('../services/monitor');
const { lastWorkDay, isWeekend, cleanItems, summary } = require('../utils/standup');

const router = express.Router();

/** Mine: personal to-dos I am on, and business tasks I am accountable for. */
const MINE = `((t.business_id IS NULL AND EXISTS (SELECT 1 FROM todo_members m WHERE m.todo_id = t.id AND m.user_id = $1))
               OR (t.business_id IS NOT NULL AND t.assignee_id = $1 AND t.review_state = 'accepted'))`;

/** What a stand-up would say today, worked out from what the person did and has open. */
async function draftFor(userId, today) {
  const since = lastWorkDay(today);
  const [done, doing, blockers] = await Promise.all([
    db.query(
      `SELECT e.todo_id AS id, COALESCE(t.title, e.meta->>'title') AS title
       FROM todo_events e LEFT JOIN todos t ON t.id = e.todo_id
       WHERE e.kind = 'completed' AND e.subject_id = $1
         AND (e.created_at AT TIME ZONE $2)::date >= $3::date
         AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
       ORDER BY e.created_at DESC LIMIT 12`,
      [userId, APP_TIMEZONE, since]
    ),
    db.query(
      `SELECT t.id, t.title FROM todos t
       WHERE t.is_done = FALSE AND t.parent_id IS NULL AND t.review_state <> 'rejected' AND ${MINE}
         AND (t.status = 'in_progress' OR (t.due_date IS NOT NULL AND t.due_date <= $2::date))
       ORDER BY t.priority, t.due_date NULLS LAST, t.id LIMIT 12`,
      [userId, today]
    ),
    db.query(
      `SELECT t.id, t.title || ' (' || CASE WHEN b.note <> '' THEN b.note ELSE b.kind END || ')' AS title
       FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
       WHERE b.resolved_at IS NULL AND t.is_done = FALSE AND ${MINE}
       ORDER BY b.raised_at LIMIT 8`,
      [userId]
    ),
  ]);
  return { since, done: done.rows, doing: doing.rows, blockers: blockers.rows };
}

const POST_SELECT = `
  SELECT s.id, s.user_id, s.day::text AS day, s.done, s.doing, s.blockers, s.note, s.created_at, s.updated_at,
         u.name, u.username, u.profile_picture
  FROM standups s JOIN users u ON u.id = s.user_id`;

// GET /api/standup/today — the draft built from my work, and today's post if I already made one
router.get('/today', authenticate, async (req, res, next) => {
  try {
    const today = todayInAppZone();
    const [draft, posted] = await Promise.all([
      draftFor(req.user.id, today),
      db.query(`${POST_SELECT} WHERE s.user_id = $1 AND s.day = $2::date`, [req.user.id, today]),
    ]);
    res.json({ day: today, weekend: isWeekend(today), draft, posted: posted.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/standup — { done, doing, blockers, note }: post (or update) today's stand-up
router.post('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor) return res.status(401).json({ error: 'User no longer exists' });
    const today = todayInAppZone();
    const done = cleanItems(req.body.done);
    const doing = cleanItems(req.body.doing);
    const blockers = cleanItems(req.body.blockers, 8);
    const note = sanitizeText(req.body.note, 1000) || '';
    if (!done.length && !doing.length && !blockers.length && !note) {
      return res.status(400).json({ error: 'Add at least one line to your stand-up' });
    }
    const existed = await db.query('SELECT 1 FROM standups WHERE user_id = $1 AND day = $2::date', [actor.id, today]);
    const saved = await db.query(
      `INSERT INTO standups (user_id, day, done, doing, blockers, note)
       VALUES ($1, $2::date, $3::jsonb, $4::jsonb, $5::jsonb, $6)
       ON CONFLICT (user_id, day) DO UPDATE
         SET done = EXCLUDED.done, doing = EXCLUDED.doing, blockers = EXCLUDED.blockers, note = EXCLUDED.note, updated_at = NOW()
       RETURNING id`,
      [actor.id, today, JSON.stringify(done), JSON.stringify(doing), JSON.stringify(blockers), note]
    );
    if (!existed.rows.length) {
      // The first post of the day tells the next person up the chain, once.
      const businesses = await db.query('SELECT business_id FROM user_businesses WHERE user_id = $1', [actor.id]);
      const audience = new Set();
      for (const { business_id: bid } of businesses.rows) {
        for (const id of await nextApprovers(bid, actorLevelIn(actor, bid), actor.id)) audience.add(id);
      }
      if (audience.size) {
        await notify([...audience], {
          type: 'standup_posted',
          title: `${actor.name} posted a stand-up`,
          body: summary({ done, doing, blockers }),
          data: { standup: true },
        });
      }
    }
    const row = await db.query(`${POST_SELECT} WHERE s.id = $1`, [saved.rows[0].id]);
    res.status(201).json({ standup: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/standup/today — take today's post back
router.delete('/today', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM standups WHERE user_id = $1 AND day = $2::date', [req.user.id, todayInAppZone()]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/standup/feed?day= — what the people I work with posted; leaders also see who has not posted yet
router.get('/feed', authenticate, async (req, res, next) => {
  try {
    const today = todayInAppZone();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : today;
    const { people: watched } = await monitorablePeople(req.user.id);
    const colleagues = await db.query(
      `SELECT DISTINCT ub2.user_id AS id FROM user_businesses ub
       JOIN user_businesses ub2 ON ub2.business_id = ub.business_id AND ub2.user_id <> ub.user_id
       WHERE ub.user_id = $1`,
      [req.user.id]
    );
    const ids = [...new Set([...watched.map((p) => p.id), ...colleagues.rows.map((r) => r.id)])];
    const posts = ids.length
      ? await db.query(`${POST_SELECT} WHERE s.day = $1::date AND s.user_id = ANY($2::int[]) ORDER BY s.created_at DESC`, [day, ids])
      : { rows: [] };
    const postedIds = new Set(posts.rows.map((r) => r.user_id));
    const missing = isWeekend(day)
      ? []
      : watched.filter((p) => !postedIds.has(p.id)).map((p) => ({ id: p.id, name: p.name, profile_picture: p.profile_picture, display_title: p.display_title }));
    res.json({ day, weekend: isWeekend(day), posts: posts.rows, missing, can_see_missing: watched.length > 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/standup/nudge — { user_id }: a leader reminds someone they watch to post
router.post('/nudge', authenticate, async (req, res, next) => {
  try {
    const targetId = Number(req.body.user_id);
    const { actor, people } = await monitorablePeople(req.user.id);
    if (!actor || !people.some((p) => p.id === targetId)) return res.status(403).json({ error: 'You cannot nudge this person' });
    const done = await db.query('SELECT 1 FROM standups WHERE user_id = $1 AND day = $2::date', [targetId, todayInAppZone()]);
    if (done.rows.length) return res.json({ nudged: false });
    await notify([targetId], {
      type: 'standup_nudge',
      title: 'Stand-up time',
      body: `${actor.name} is waiting for your stand-up. It takes one tap.`,
      data: { standup: true },
    });
    res.json({ nudged: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
