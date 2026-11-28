// /api/agents: the AI agents connected to my account, and removing one. Signed in with the app's own login.
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { connectionsOf, removeConnection } = require('../services/agentAccess');
const { mcpConfig, mayConnect } = require('../utils/agentRules');

const router = express.Router();

router.get('/', authenticate, async (req, res, next) => {
  try {
    const config = mcpConfig();
    res.json({
      enabled: config.on && mayConnect(config, req.user.username),
      url: config.on ? `${config.base}/mcp` : null,
      agents: await connectionsOf(req.user.id),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id(\\d{1,9})', authenticate, async (req, res, next) => {
  try {
    if (!(await removeConnection(req.user.id, Number(req.params.id)))) return res.status(404).json({ error: 'Connection not found' });
    return res.json({ message: 'Disconnected' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
