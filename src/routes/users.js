const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { sanitizeText, validatePassword } = require('../middleware/sanitize');
const { loadActor, actorBestLevel } = require('../utils/org');
const { setMemberships, syncLeaderGroups } = require('../services/org');
const { notify } = require('../utils/notify');

const router = express.Router();

/** Managing someone requires being strictly more senior than them. */
async function outranks(actorId, targetId) {
  if (Number(actorId) === Number(targetId)) return false;
  const [actor, target] = await Promise.all([loadActor(actorId), loadActor(targetId)]);
  if (!actor || !target) return false;
  return actorBestLevel(actor) < actorBestLevel(target);
}

// GET /api/users/unassigned (admin only)
router.get('/unassigned', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.username, u.role, u.status, u.created_at
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

    const isSuperAdmin = req.user.role === 'super_admin';
    const roleFilter = isSuperAdmin ? '' : "WHERE u.role != 'super_admin'";
    const countFilter = isSuperAdmin ? '' : "WHERE role != 'super_admin'";
    const emailColumn = isSuperAdmin ? 'u.email,' : '';

    const countResult = await db.query(`SELECT COUNT(*) FROM users ${countFilter}`);
    const total = parseInt(countResult.rows[0].count);

    const result = await db.query(
      `SELECT u.id, u.name, u.username, ${emailColumn} u.role, u.status, u.business_id, u.created_at,
              u.org_level, u.title, u.profile_picture,
              COALESCE(
                json_agg(
                  json_build_object('id', b.id, 'name', b.name, 'type', b.type, 'designation', ub.designation)
                ) FILTER (WHERE b.id IS NOT NULL), '[]'
              ) AS businesses
       FROM users u
       LEFT JOIN user_businesses ub ON ub.user_id = u.id
       LEFT JOIN businesses b ON b.id = ub.business_id
       ${roleFilter}
       GROUP BY u.id
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

// PUT /api/users/:id/assign (admin only) — supports single or multiple businesses.
// Keeps each person's designation in businesses they stay in; new ones start as "member".
router.put('/:id/assign', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { business_id, business_ids } = req.body;

    let bizIds = [];
    if (Array.isArray(business_ids)) {
      bizIds = business_ids.map(Number).filter((n) => !isNaN(n) && n > 0);
    } else if (business_id !== undefined && business_id !== null) {
      bizIds = [Number(business_id)].filter((n) => !isNaN(n) && n > 0);
    }
    bizIds = [...new Set(bizIds)];

    const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (Number(id) !== req.user.id && !(await outranks(req.user.id, id))) {
      return res.status(403).json({ error: 'You can only manage people below you in the hierarchy' });
    }

    let bizNames = [];
    if (bizIds.length) {
      const bizCheck = await db.query('SELECT id, name FROM businesses WHERE id = ANY($1)', [bizIds]);
      if (bizCheck.rows.length !== bizIds.length) {
        return res.status(404).json({ error: 'One or more businesses not found' });
      }
      bizNames = bizCheck.rows.map((r) => r.name);
    }

    const existing = await db.query('SELECT business_id, designation, title FROM user_businesses WHERE user_id = $1', [id]);
    const keep = new Map(existing.rows.map((m) => [m.business_id, m]));
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await setMemberships(client, Number(id), bizIds.map((bid) => keep.get(bid) || { business_id: bid, designation: 'member' }));
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await notify([Number(id)], {
      type: 'assignment',
      title: 'Your businesses changed',
      body: bizNames.length ? `You are now part of: ${bizNames.join(', ')}` : 'You have been unassigned from all businesses',
      data: {},
    });

    res.json({ user: { id: parseInt(id), business_id: bizIds[0] || null, business_ids: bizIds } });
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

    const userCheck = await db.query('SELECT id, role, org_level FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (userCheck.rows[0].role === 'super_admin' || !(await outranks(req.user.id, id))) {
      return res.status(403).json({ error: 'You can only change the role of people below you' });
    }

    // "Admin" maps to the Director tier of the organisation.
    const orgLevel = role === 'admin' ? 3 : null;
    const result = await db.query(
      `UPDATE users SET role = $1, org_level = $2 WHERE id = $3
       RETURNING id, name, username, role, business_id, status, org_level`,
      [role, orgLevel, id]
    );
    await syncLeaderGroups(db, Number(id), role);

    await notify([Number(id)], {
      type: 'assignment',
      title: role === 'admin' ? 'You were promoted to Director' : 'Your role changed',
      body: role === 'admin'
        ? 'You can now see and manage tasks across every business.'
        : 'Your role has been changed to a regular member.',
      data: {},
    });

    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id (admin only — only people below you in the hierarchy)
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res.status(403).json({ error: 'You cannot delete your own account' });
    }

    const userCheck = await db.query('SELECT id, role, org_level FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (userCheck.rows[0].role === 'super_admin' && !userCheck.rows[0].org_level) {
      return res.status(403).json({ error: 'Cannot delete the system super admin' });
    }
    if (!(await outranks(req.user.id, id))) {
      return res.status(403).json({ error: 'You can only delete people below you in the hierarchy' });
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
           COUNT(*) FILTER (WHERE status = 'done') AS tasks_completed,
           COUNT(*) FILTER (WHERE status = 'todo') AS tasks_pending,
           COUNT(*) FILTER (WHERE status = 'on_hold') AS tasks_on_hold
         FROM todos
         WHERE business_id IS NOT NULL AND (created_by = $1 OR assignee_id = $1)`,
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
        db.query('SELECT COUNT(*) AS cnt FROM todos WHERE business_id IS NOT NULL'),
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
      `SELECT w.id, t.title AS task_title, w.todo_id, w.message, u.name AS sent_by_name,
              w.created_at, w.is_read
       FROM warnings w
       JOIN todos t ON w.todo_id = t.id
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
    const trimmed = sanitizeText(req.body.name, 100);
    if (!trimmed) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const result = await db.query(
      `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, username, role, business_id, status, created_at`,
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
    const pwError = validatePassword(new_password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
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
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2',
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

    if (!new_password) {
      return res.status(400).json({ error: 'New password is required' });
    }
    const pwError = validatePassword(new_password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await outranks(req.user.id, id))) {
      return res.status(403).json({ error: 'You can only reset passwords for people below you' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW() WHERE id = $2',
      [hash, id]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
