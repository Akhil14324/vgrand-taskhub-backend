const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — current user's notifications (paginated)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const unreadResult = await db.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );

    const totalResult = await db.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1',
      [req.user.id]
    );
    const total = parseInt(totalResult.rows[0].count);

    res.json({
      notifications: result.rows,
      unread_count: parseInt(unreadResult.rows[0].count),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/:id/read — mark a single notification as read
router.put('/:id/read', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `UPDATE notifications SET is_read = true
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ notification: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/read-all — mark all as read
router.put('/read-all', authenticate, async (req, res, next) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/push-token — register a push notification token
router.post('/push-token', authenticate, async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Push token is required' });
    }
    await db.query(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW(), platform = $3`,
      [req.user.id, token, platform || 'android']
    );
    res.json({ message: 'Push token registered' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/push-token — unregister a push notification token
router.delete('/push-token', authenticate, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Push token is required' });
    }
    await db.query(
      'DELETE FROM push_tokens WHERE user_id = $1 AND token = $2',
      [req.user.id, token]
    );
    res.json({ message: 'Push token removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
