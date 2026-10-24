const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const erp = require('../services/erpApprovals');

/**
 * Hospital ERP approvals (services/erpApprovals.js).
 *
 *   GET    /api/erp/approvals   my ERP approvals (linked people), or { linked: false }
 *   POST   /api/erp/link        { code } link my ERP account with the 6-digit code made in the ERP
 *   DELETE /api/erp/link        unlink
 *   POST   /api/erp/webhook     the ERP says approvals changed (signed with TASKHUB_SYNC_SECRET)
 */
const router = express.Router();

const linkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `erp-link-${req.user?.id || req.ip}`,
  message: { error: 'Too many tries. Make a new code in the ERP and try again in a few minutes.' },
});

const sendError = (res, err, next) => {
  if (err instanceof erp.ErpError) return res.status(err.statusCode || 502).json({ error: err.message, code: err.code });
  return next(err);
};

router.get('/approvals', authenticate, async (req, res, next) => {
  try {
    res.json(await erp.getApprovals(req.user.id, { fresh: req.query.fresh === '1' }));
  } catch (err) {
    sendError(res, err, next);
  }
});

router.post('/link', authenticate, linkLimiter, async (req, res, next) => {
  try {
    res.json(await erp.link(req.user.id, req.body?.code));
  } catch (err) {
    sendError(res, err, next);
  }
});

router.delete('/link', authenticate, async (req, res, next) => {
  try {
    await erp.clearLink(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/webhook', (req, res) => {
  if (!erp.isConfigured()) return res.status(503).json({ error: 'Not configured' });
  if (!erp.isValidNudge(req)) return res.status(401).json({ error: 'Bad signature' });
  res.status(202).json({ ok: true });
  erp.syncAll();
});

module.exports = router;
