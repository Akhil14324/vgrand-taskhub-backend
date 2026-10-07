const express = require('express');
const { authenticate } = require('../middleware/auth');
const { loadActor } = require('../utils/org');
const { actorCanMonitor, parseDays } = require('../services/monitor');
const { businessHealth, workloadBalance, estimateAccuracy } = require('../services/insights');

const router = express.Router();

/** Leadership and business heads only (the same people who may use the Team monitor). */
async function requireLeadership(req, res, next) {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor || !actor.can('insights')) return res.status(403).json({ error: 'You do not have access to this' });
    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/insights/health?days=7|30|90 — every business I look after, with a health score and trend
router.get('/health', authenticate, requireLeadership, async (req, res, next) => {
  try {
    res.json(await businessHealth(req.actor, parseDays(req.query.days)));
  } catch (err) {
    next(err);
  }
});

// GET /api/insights/workload — how full each person below me is, and who could take some work
router.get('/workload', authenticate, requireLeadership, async (req, res, next) => {
  try {
    const out = await workloadBalance(req.user.id);
    delete out.actor;
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// GET /api/insights/estimates?days=&scope=me|team — estimate vs actual. Anyone may see their own.
router.get('/estimates', authenticate, async (req, res, next) => {
  try {
    const days = parseDays(req.query.days);
    let scope = req.query.scope === 'team' ? 'team' : 'me';
    if (scope === 'team') {
      const actor = await loadActor(req.user.id);
      if (!actorCanMonitor(actor)) scope = 'me';
    }
    res.json(await estimateAccuracy(req.user.id, days, scope));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
