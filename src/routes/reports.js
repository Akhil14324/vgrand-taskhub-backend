const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor } = require('../utils/org');
const { businessHealth, workloadBalance } = require('../services/insights');
const { chatJSON, configured } = require('../utils/openai');
const { todayInAppZone } = require('../utils/recurrence');

// /api/reports: the weekly report for leadership (same people who see business health), made from the numbers
// the app already keeps. With an OpenAI key it also gets a short plain-language summary on top.
const router = express.Router();

/** Yesterday (company time zone) for the businesses in this person's scope, plus a short summary when AI is on. */
async function dailyReport(actor) {
  const health = await businessHealth(actor, 7);
  const ids = health.businesses.map((b) => b.id);
  const names = new Map(health.businesses.map((b) => [b.id, b.name]));
  const zone = require('../utils/recurrence').APP_TIMEZONE;
  const finished = ids.length ? (await db.query(
    `SELECT COALESCE((e.meta->>'business_id')::int, t.business_id) AS business_id, u.name AS who, COUNT(*)::int AS n
     FROM todo_events e LEFT JOIN todos t ON t.id = e.todo_id LEFT JOIN users u ON u.id = e.user_id
     WHERE e.kind = 'completed' AND COALESCE((e.meta->>'is_subtask')::boolean, FALSE) = FALSE
       AND (e.created_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date - 1
       AND COALESCE((e.meta->>'business_id')::int, t.business_id) = ANY($1::int[])
     GROUP BY 1, 2 ORDER BY n DESC`, [ids, zone]
  )).rows : [];
  const blockers = ids.length ? (await db.query(
    `SELECT t.title, t.business_id FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
     WHERE t.business_id = ANY($1::int[]) AND (b.raised_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date - 1 LIMIT 10`, [ids, zone]
  )).rows : [];
  const decisions = ids.length ? (await db.query(
    `SELECT r.decision, COUNT(*)::int AS n FROM todo_step_reviews r JOIN todos s ON s.id = r.todo_id JOIN todos p ON p.id = s.parent_id
     WHERE p.business_id = ANY($1::int[]) AND (r.created_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date - 1 GROUP BY r.decision`, [ids, zone]
  )).rows : [];
  const perBusiness = health.businesses.map((b) => ({
    id: b.id, name: b.name, overdue: b.overdue, blocked: b.blocked,
    finished: finished.filter((f) => f.business_id === b.id).reduce((n, f) => n + f.n, 0),
  }));
  const report = {
    totals: { finished: perBusiness.reduce((n, b) => n + b.finished, 0), new_blockers: blockers.length, overdue: perBusiness.reduce((n, b) => n + b.overdue, 0) },
    businesses: perBusiness,
    top: finished.slice(0, 5).map((f) => ({ who: f.who, business: names.get(f.business_id), n: f.n })),
    blockers: blockers.map((b) => ({ title: b.title, business: names.get(b.business_id) })),
    decisions,
    narrative: null,
  };
  if (configured() && ids.length) {
    try {
      const out = await chatJSON({
        system: 'You write the 30-second morning brief a company leader reads about yesterday. Plain sentences, no markdown, no greeting, at most 70 words. '
          + 'Say what got done, what went wrong or got stuck, and the one thing to look at first, naming the business or person. Use only the numbers given. Reply as JSON {"narrative":"..."}.',
        user: JSON.stringify(report),
        maxTokens: 250,
      });
      report.narrative = String(out.narrative || '').slice(0, 600) || null;
    } catch { /* the numbers are enough */ }
  }
  return report;
}

router.get('/weekly', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor || !actor.can('insights')) return res.status(403).json({ error: 'You do not have access to this' });
    const days = Math.max(7, Math.min(31, parseInt(req.query.days, 10) || 7));
    const health = await businessHealth(actor, days);
    const ids = health.businesses.map((b) => b.id);

    const stuck = ids.length ? (await db.query(
      `SELECT t.id, t.title, b.name AS business, u.name AS who, bl.kind, bl.note,
              EXTRACT(DAY FROM NOW() - bl.raised_at)::int AS days
       FROM todo_blockers bl JOIN todos t ON t.id = bl.todo_id
       JOIN businesses b ON b.id = t.business_id LEFT JOIN users u ON u.id = t.assignee_id
       WHERE bl.resolved_at IS NULL AND t.is_done = FALSE AND t.business_id = ANY($1::int[]) AND bl.raised_at < NOW() - INTERVAL '2 days'
       ORDER BY bl.raised_at LIMIT 10`, [ids]
    )).rows : [];
    const late = ids.length ? (await db.query(
      `SELECT t.id, t.title, b.name AS business, u.name AS who, (CURRENT_DATE - t.due_date)::int AS days_late
       FROM todos t JOIN businesses b ON b.id = t.business_id LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.business_id = ANY($1::int[]) AND t.is_done = FALSE AND t.parent_id IS NULL AND t.review_state = 'accepted'
         AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE
       ORDER BY t.due_date LIMIT 10`, [ids]
    )).rows : [];
    const waiting = ids.length ? (await db.query(
      `SELECT s.id, s.title, p.title AS parent, EXTRACT(DAY FROM NOW() - s.step_since)::int AS days
       FROM todos s JOIN todos p ON p.id = s.parent_id
       WHERE s.step_state = 'awaiting_review' AND p.business_id = ANY($1::int[]) ORDER BY s.step_since LIMIT 10`, [ids]
    )).rows : [];
    const workload = await workloadBalance(req.user.id);
    const overloaded = (workload.people || []).filter((p) => p.ratio > 1).slice(0, 6).map((p) => ({ id: p.id, name: p.name, open: p.open, overdue: p.overdue }));

    const report = {
      today: todayInAppZone(),
      days,
      totals: health.totals,
      businesses: health.businesses.map((b) => ({
        id: b.id, name: b.name, score: b.score, level: b.level, open: b.open, overdue: b.overdue, blocked: b.blocked,
        completed: b.completed, completed_change: b.completed_change, on_time_rate: b.on_time_rate, reasons: b.reasons,
      })),
      stuck, late, waiting, overloaded,
      narrative: null,
    };
    if (configured() && report.businesses.length) {
      try {
        const out = await chatJSON({
          system: 'You write the weekly summary a company leader reads in under a minute. Plain sentences, no markdown, no greeting. '
            + 'Say what went well, what is at risk, and the two or three things they should act on first, naming the business or person. '
            + 'Use only the numbers given. Reply as JSON {"narrative":"..."} with at most 120 words.',
          user: JSON.stringify({ days, totals: report.totals, businesses: report.businesses, stuck, late: late.slice(0, 5), waiting, overloaded }),
          maxTokens: 400,
        });
        report.narrative = String(out.narrative || '').slice(0, 1200) || null;
      } catch { /* the numbers are enough */ }
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/daily — what happened yesterday, for the businesses this person looks after.
router.get('/daily', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor || !actor.can('insights')) return res.status(403).json({ error: 'You do not have access to this' });
    res.json(await dailyReport(actor));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.dailyReport = dailyReport;
