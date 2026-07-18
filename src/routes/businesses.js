const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/businesses/types — existing distinct business types
router.get('/types', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('SELECT DISTINCT type FROM businesses ORDER BY type');
    res.json({ types: result.rows.map((r) => r.type) });
  } catch (err) {
    next(err);
  }
});

// GET /api/businesses (admin only) — with task counts (paginated)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const countResult = await db.query('SELECT COUNT(*) FROM businesses');
    const total = parseInt(countResult.rows[0].count);

    const result = await db.query(
      `SELECT b.*,
         COUNT(t.id) AS task_count,
         COUNT(CASE WHEN t.status = 'completed' THEN 1 END) AS completed_count,
         COUNT(CASE WHEN t.status = 'pending' THEN 1 END) AS pending_count,
         COUNT(CASE WHEN t.status = 'on_hold' THEN 1 END) AS on_hold_count,
         COUNT(CASE WHEN t.is_warned = true THEN 1 END) AS warned_count,
         (SELECT COUNT(*) FROM user_businesses ub WHERE ub.business_id = b.id) AS user_count
       FROM businesses b
       LEFT JOIN tasks t ON t.business_id = b.id
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      businesses: result.rows,
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

// POST /api/businesses (admin only)
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { name, type, description } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
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
