const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/users/unassigned (admin only)
router.get('/unassigned', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at
       FROM users u
       WHERE u.role = 'user'
         AND NOT EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = u.id)
       ORDER BY u.created_at DESC`
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
              COALESCE(
                json_agg(
                  json_build_object('id', b.id, 'name', b.name, 'type', b.type)
                ) FILTER (WHERE b.id IS NOT NULL), '[]'
              ) AS businesses
       FROM users u
       LEFT JOIN user_businesses ub ON ub.user_id = u.id
       LEFT JOIN businesses b ON b.id = ub.business_id
       WHERE u.role != 'super_admin'
       GROUP BY u.id, u.name, u.email, u.role, u.status, u.business_id, u.created_at
       ORDER BY u.created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/assign (admin only) — supports single or multiple businesses
router.put('/:id/assign', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { business_id, business_ids } = req.body;

    // Support both single (business_id) and multiple (business_ids) assignment
    let bizIds = [];
    if (Array.isArray(business_ids)) {
      bizIds = business_ids.map(Number).filter((n) => !isNaN(n));
    } else if (business_id !== undefined && business_id !== null) {
      bizIds = [Number(business_id)].filter((n) => !isNaN(n));
    }

    // Verify user exists and is not an admin
    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (['admin', 'super_admin'].includes(userCheck.rows[0].role)) {
      return res.status(400).json({ error: 'Cannot assign admin to a business' });
    }

    // If no businesses selected, unassign user from all businesses
    if (bizIds.length === 0) {
      await db.query('DELETE FROM user_businesses WHERE user_id = $1', [id]);
      await db.query('UPDATE users SET business_id = NULL WHERE id = $1', [id]);
      await db.query(
        `INSERT INTO notifications (user_id, type, message)
         VALUES ($1, 'assignment', $2)`,
        [id, 'You have been unassigned from all businesses']
      );
      return res.json({ user: { id: parseInt(id), business_id: null, business_ids: [] } });
    }

    // Verify all businesses exist
    const bizCheck = await db.query(
      'SELECT id, name FROM businesses WHERE id = ANY($1)',
      [bizIds]
    );
    if (bizCheck.rows.length !== bizIds.length) {
      return res.status(404).json({ error: 'One or more businesses not found' });
    }

    // Replace all business assignments for this user
    await db.query('DELETE FROM user_businesses WHERE user_id = $1', [id]);
    for (const bizId of bizIds) {
      await db.query(
        'INSERT INTO user_businesses (user_id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, bizId]
      );
    }

    // Keep business_id as primary (first selected)
    const primaryBizId = bizIds[0];
    await db.query('UPDATE users SET business_id = $1 WHERE id = $2', [primaryBizId, id]);

    // Create notification for the user
    const bizNames = bizCheck.rows.map((r) => r.name).join(', ');
    await db.query(
      `INSERT INTO notifications (user_id, type, message)
       VALUES ($1, 'assignment', $2)`,
      [id, `You have been assigned to: ${bizNames}`]
    );

    res.json({ user: { id: parseInt(id), business_id: primaryBizId, business_ids: bizIds } });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/role (super_admin only) — promote/demote user
router.put('/:id/role', authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either "admin" or "user"' });
    }

    // Cannot change own role
    if (parseInt(id) === req.user.id) {
      return res.status(403).json({ error: 'You cannot change your own role' });
    }

    // Verify target user exists and is not a super_admin
    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (userCheck.rows[0].role === 'super_admin') {
      return res.status(403).json({ error: 'Cannot change a super_admin\'s role' });
    }

    const result = await db.query(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, name, email, role, business_id, status`,
      [role, id]
    );

    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id (admin only — super_admin can delete admins too)
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Cannot delete yourself
    if (parseInt(id) === req.user.id) {
      return res.status(403).json({ error: 'You cannot delete your own account' });
    }

    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetRole = userCheck.rows[0].role;

    // Nobody can delete super_admin
    if (targetRole === 'super_admin') {
      return res.status(403).json({ error: 'Cannot delete a super admin' });
    }

    // Regular admins can only delete regular users
    if (req.user.role === 'admin' && targetRole === 'admin') {
      return res.status(403).json({ error: 'Only super admin can delete admin users' });
    }

    await db.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
