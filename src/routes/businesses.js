const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const VALID_TYPES = ['restaurant', 'hospital', 'construction', 'mines', 'it', 'other'];

// GET /api/businesses (admin only) — with task counts
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT b.*,
         COUNT(t.id) AS task_count,
         COUNT(CASE WHEN t.status = 'completed' THEN 1 END) AS completed_count,
         COUNT(CASE WHEN t.status = 'pending' THEN 1 END) AS pending_count,
         COUNT(CASE WHEN t.is_warned = true THEN 1 END) AS warned_count,
         (SELECT COUNT(*) FROM users u WHERE u.business_id = b.id) AS user_count
       FROM businesses b
       LEFT JOIN tasks t ON t.business_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC`
    );
    res.json({ businesses: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/businesses (admin only)
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, type, description } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid business type' });
    }

    const result = await db.query(
      `INSERT INTO businesses (name, type, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, type, description || '']
    );

    res.status(201).json({ business: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/businesses/:id (admin only)
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, type, description } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid business type' });
    }

    const result = await db.query(
      `UPDATE businesses SET name = $1, type = $2, description = $3
       WHERE id = $4 RETURNING *`,
      [name, type, description || '', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    res.json({ business: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/businesses/:id (admin only)
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'DELETE FROM businesses WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    res.json({ message: 'Business deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
