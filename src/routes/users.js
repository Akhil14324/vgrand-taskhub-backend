const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/users/unassigned (admin only)
router.get('/unassigned', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, role, status, created_at
       FROM users
       WHERE business_id IS NULL AND role = 'user'
       ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/users (admin only) — all users with business info
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.business_id, u.created_at,
              b.name AS business_name, b.type AS business_type
       FROM users u
       LEFT JOIN businesses b ON u.business_id = b.id
       ORDER BY u.created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/assign (admin only)
router.put('/:id/assign', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { business_id } = req.body;

    if (business_id === undefined || business_id === null) {
      return res.status(400).json({ error: 'business_id is required' });
    }

    // Verify business exists
    const bizCheck = await db.query('SELECT id FROM businesses WHERE id = $1', [business_id]);
    if (bizCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Verify user exists and is not an admin
    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (userCheck.rows[0].role === 'admin') {
      return res.status(400).json({ error: 'Cannot assign admin to a business' });
    }

    const result = await db.query(
      `UPDATE users SET business_id = $1 WHERE id = $2
       RETURNING id, name, email, role, business_id, status`,
      [business_id, id]
    );

    // Create notification for the user
    const bizResult = await db.query('SELECT name FROM businesses WHERE id = $1', [business_id]);
    const bizName = bizResult.rows[0]?.name || 'a business';
    await db.query(
      `INSERT INTO notifications (user_id, type, message)
       VALUES ($1, 'assignment', $2)`,
      [id, `You have been assigned to ${bizName}`]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
