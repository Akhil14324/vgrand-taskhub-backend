const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');

const router = express.Router();

async function createBusinessGroup(businessId, businessName, createdByUserId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const convResult = await client.query(
      `INSERT INTO conversations (type, name, business_id, created_by)
       VALUES ('group', $1, $2, $3) RETURNING id`,
      [businessName, businessId, createdByUserId]
    );
    const conversationId = convResult.rows[0].id;

    const adminsResult = await client.query(
      `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND status = 'active'`
    );

    const assignedResult = await client.query(
      `SELECT ub.user_id FROM user_businesses ub
       JOIN users u ON u.id = ub.user_id
       WHERE ub.business_id = $1 AND u.status = 'active'`,
      [businessId]
    );

    const allUserIds = new Set();
    adminsResult.rows.forEach((r) => allUserIds.add(r.id));
    assignedResult.rows.forEach((r) => allUserIds.add(r.user_id));
    allUserIds.add(createdByUserId);

    for (const uid of allUserIds) {
      const isSuperAdmin = adminsResult.rows.some(
        (r) => r.id === uid
      ) && await client.query('SELECT role FROM users WHERE id = $1', [uid]).then((r) => r.rows[0]?.role === 'super_admin');

      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, is_admin, is_invisible)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [conversationId, uid, uid === createdByUserId, isSuperAdmin]
      );
    }

    await client.query('COMMIT');
    return conversationId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const BUSINESS_COLORS = ['indigo', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

// GET /api/businesses/directory — every business with its heads (any signed-in user,
// used to raise tasks for other businesses)
router.get('/directory', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT b.id, b.name, b.type, b.color,
         COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username))
           FILTER (WHERE u.id IS NOT NULL), '[]') AS heads,
         EXISTS (SELECT 1 FROM user_businesses me WHERE me.business_id = b.id AND me.user_id = $1) AS is_member
       FROM businesses b
       LEFT JOIN user_businesses ub ON ub.business_id = b.id AND ub.designation = 'head'
       LEFT JOIN users u ON u.id = ub.user_id AND u.status != 'inactive'
       GROUP BY b.id
       ORDER BY b.sort_order, b.name`,
      [req.user.id]
    );
    res.json({ businesses: result.rows });
  } catch (err) {
    next(err);
  }
});

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
         COUNT(CASE WHEN t.status = 'done' THEN 1 END) AS completed_count,
         COUNT(CASE WHEN t.status = 'todo' THEN 1 END) AS pending_count,
         COUNT(CASE WHEN t.status = 'on_hold' THEN 1 END) AS on_hold_count,
         COUNT(CASE WHEN t.is_warned = true THEN 1 END) AS warned_count,
         (SELECT COUNT(*) FROM user_businesses ub WHERE ub.business_id = b.id) AS user_count
       FROM businesses b
       LEFT JOIN todos t ON t.business_id = b.id AND t.parent_id IS NULL AND t.review_state = 'accepted'
       GROUP BY b.id
       ORDER BY b.sort_order, b.name ASC
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
    const name = sanitizeText(req.body.name, 100);
    const type = sanitizeText(req.body.type, 50);
    const description = sanitizeText(req.body.description, 1000);
    const color = BUSINESS_COLORS.includes(req.body.color) ? req.body.color : null;

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }

    const result = await db.query(
      `INSERT INTO businesses (name, type, description, color, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM businesses))
       RETURNING *`,
      [name, type, description || '', color]
    );

    const business = result.rows[0];

    try {
      await createBusinessGroup(business.id, business.name, req.user.id);
    } catch (groupErr) {
      console.error('[businesses] Failed to auto-create group:', groupErr.message);
    }

    res.status(201).json({ business });
  } catch (err) {
    next(err);
  }
});

// PUT /api/businesses/:id (admin only)
router.put('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const name = sanitizeText(req.body.name, 100);
    const type = sanitizeText(req.body.type, 50);
    const description = sanitizeText(req.body.description, 1000);

    if (!name || !type) {
      return res.status(400).json({ error: 'Name and type are required' });
    }

    const color = BUSINESS_COLORS.includes(req.body.color) ? req.body.color : null;
    const result = await db.query(
      `UPDATE businesses SET name = $1, type = $2, description = $3, color = COALESCE($5, color)
       WHERE id = $4 RETURNING *`,
      [name, type, description || '', id, color]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    await db.query(
      `UPDATE conversations SET name = $1 WHERE business_id = $2 AND type = 'group'`,
      [name, id]
    );

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
