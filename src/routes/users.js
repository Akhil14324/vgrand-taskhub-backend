const express = require('express');
const bcrypt = require('bcryptjs');
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

// GET /api/users (admin only) — all users with business info (paginated)
router.get('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const countResult = await db.query("SELECT COUNT(*) FROM users WHERE role != 'super_admin'");
    const total = parseInt(countResult.rows[0].count);

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
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({
      users: result.rows,
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

// GET /api/users/me/stats (authenticate only)
router.get('/me/stats', authenticate, async (req, res, next) => {
  try {
    if (req.user.role === 'user') {
      const taskStats = await db.query(
        `SELECT
           COUNT(*) AS tasks_created,
           COUNT(*) FILTER (WHERE status = 'completed') AS tasks_completed,
           COUNT(*) FILTER (WHERE status = 'pending') AS tasks_pending,
           COUNT(*) FILTER (WHERE status = 'on_hold') AS tasks_on_hold
         FROM tasks
         WHERE created_by = $1 OR assigned_user_id = $1`,
        [req.user.id]
      );
      const warningCount = await db.query(
        'SELECT COUNT(*) AS cnt FROM warnings WHERE user_id = $1',
        [req.user.id]
      );
      const created = parseInt(taskStats.rows[0].tasks_created) || 0;
      const completed = parseInt(taskStats.rows[0].tasks_completed) || 0;
      const completionRate = created > 0 ? Math.round((completed / created) * 100) : 0;
      res.json({
        role: 'user',
        tasks_created: created,
        tasks_completed: completed,
        tasks_pending: parseInt(taskStats.rows[0].tasks_pending) || 0,
        tasks_on_hold: parseInt(taskStats.rows[0].tasks_on_hold) || 0,
        completion_rate: completionRate,
        warnings_count: parseInt(warningCount.rows[0].cnt) || 0,
      });
    } else {
      const [bizRes, userRes, taskRes] = await Promise.all([
        db.query('SELECT COUNT(*) AS cnt FROM businesses'),
        db.query("SELECT COUNT(*) AS cnt FROM users WHERE role != 'super_admin'"),
        db.query('SELECT COUNT(*) AS cnt FROM tasks'),
      ]);
      res.json({
        role: req.user.role,
        businesses_count: parseInt(bizRes.rows[0].cnt) || 0,
        total_users: parseInt(userRes.rows[0].cnt) || 0,
        total_tasks: parseInt(taskRes.rows[0].cnt) || 0,
      });
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me/businesses (authenticate only)
router.get('/me/businesses', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT b.id, b.name, b.type
       FROM user_businesses ub
       JOIN businesses b ON ub.business_id = b.id
       WHERE ub.user_id = $1
       ORDER BY b.name`,
      [req.user.id]
    );
    res.json({ businesses: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me/warnings (authenticate only)
router.get('/me/warnings', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT w.id, t.title AS task_title, w.message, u.name AS sent_by_name,
              w.created_at, w.is_read
       FROM warnings w
       JOIN tasks t ON w.task_id = t.id
       LEFT JOIN users u ON w.sent_by = u.id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC
       LIMIT 10`,
      [req.user.id]
    );
    res.json({ warnings: result.rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/me (authenticate only) — update name
router.put('/me', authenticate, async (req, res, next) => {
  try {
    const { name } = req.body;
    const trimmed = name ? name.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const result = await db.query(
      `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, email, role, business_id, status, created_at`,
      [trimmed, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const updatedUser = result.rows[0];
    const bizResult = await db.query(
      'SELECT name AS business_name, type AS business_type FROM businesses WHERE id = $1',
      [updatedUser.business_id]
    );
    if (bizResult.rows.length > 0) {
      updatedUser.business_name = bizResult.rows[0].business_name;
      updatedUser.business_type = bizResult.rows[0].business_type;
    }
    res.json({ user: updatedUser });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/me/password (authenticate only)
router.put('/me/password', authenticate, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const userRes = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const valid = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, req.user.id]
    );
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/password (super_admin only) — reset a user's password
router.put('/:id/password', authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;

    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (userCheck.rows[0].role === 'super_admin') {
      return res.status(403).json({ error: 'Cannot change a super admin\'s password here' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, id]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
