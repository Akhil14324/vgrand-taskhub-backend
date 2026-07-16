const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/tasks?business_id=X&status=pending
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { business_id, status } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (business_id) {
      conditions.push(`t.business_id = $${paramIdx++}`);
      params.push(business_id);
    }

    if (status && ['pending', 'completed'].includes(status)) {
      conditions.push(`t.status = $${paramIdx++}`);
      params.push(status);
    }

    // Non-admin users can only see tasks in their own business
    if (req.user.role !== 'admin') {
      if (!req.user.business_id) {
        return res.json({ tasks: [] });
      }
      conditions.push(`t.business_id = $${paramIdx++}`);
      params.push(req.user.business_id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT t.*,
         u.name AS created_by_name,
         c.name AS completed_by_name,
         b.name AS business_name,
         b.type AS business_type
       FROM tasks t
       JOIN users u ON t.created_by = u.id
       LEFT JOIN users c ON t.completed_by = c.id
       JOIN businesses b ON t.business_id = b.id
       ${whereClause}
       ORDER BY t.created_at DESC`,
      params
    );

    res.json({ tasks: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { title, description, due_date, business_id } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    let taskBusinessId = business_id;

    // Non-admin users can only create tasks in their own business
    if (req.user.role !== 'admin') {
      if (!req.user.business_id) {
        return res.status(403).json({ error: 'You must be assigned to a business to create tasks' });
      }
      taskBusinessId = req.user.business_id;
    }

    if (!taskBusinessId) {
      return res.status(400).json({ error: 'business_id is required' });
    }

    // Verify business exists
    const bizCheck = await db.query('SELECT id FROM businesses WHERE id = $1', [taskBusinessId]);
    if (bizCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const result = await db.query(
      `INSERT INTO tasks (business_id, created_by, title, description, due_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [taskBusinessId, req.user.id, title.trim(), description || '', due_date || null]
    );

    // Create notifications for all users in that business
    const usersInBiz = await db.query(
      'SELECT id FROM users WHERE business_id = $1 AND id != $2',
      [taskBusinessId, req.user.id]
    );
    for (const u of usersInBiz.rows) {
      await db.query(
        `INSERT INTO notifications (user_id, type, message)
         VALUES ($1, 'task_added', $2)`,
        [u.id, `New task added: "${title.trim()}"`]
      );
    }

    res.status(201).json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id/complete — toggle complete status
router.put('/:id/complete', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get the task
    const taskResult = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Non-admin users can only toggle tasks in their own business
    if (req.user.role !== 'admin') {
      if (!req.user.business_id || task.business_id !== req.user.business_id) {
        return res.status(403).json({ error: 'You can only modify tasks in your business' });
      }
    }

    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    const completedBy = newStatus === 'completed' ? req.user.id : null;
    const completedAt = newStatus === 'completed' ? new Date() : null;

    const result = await db.query(
      `UPDATE tasks
       SET status = $1, completed_by = $2, completed_at = $3
       WHERE id = $4
       RETURNING *`,
      [newStatus, completedBy, completedAt, id]
    );

    res.json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id/warn (admin only — creates warning + notification)
router.put('/:id/warn', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { message, user_id } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Warning message is required' });
    }

    // Get the task
    const taskResult = await db.query(
      `SELECT t.*, u.name AS creator_name FROM tasks t
       JOIN users u ON t.created_by = u.id
       WHERE t.id = $1`,
      [id]
    );
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    if (task.status === 'completed') {
      return res.status(400).json({ error: 'Cannot warn on a completed task' });
    }

    // Determine who to warn: specified user_id, or the task creator
    const warnUserId = user_id || task.created_by;

    // Verify user exists
    const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [warnUserId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create warning record
    await db.query(
      `INSERT INTO warnings (task_id, user_id, sent_by, message)
       VALUES ($1, $2, $3, $4)`,
      [id, warnUserId, req.user.id, message.trim()]
    );

    // Mark task as warned
    await db.query('UPDATE tasks SET is_warned = true WHERE id = $1', [id]);

    // Update user status to warned
    await db.query("UPDATE users SET status = 'warned' WHERE id = $1", [warnUserId]);

    // Create notification
    await db.query(
      `INSERT INTO notifications (user_id, type, message)
       VALUES ($1, 'warning', $2)`,
      [warnUserId, `Warning on task "${task.title}": ${message.trim()}`]
    );

    res.json({ message: 'Warning sent successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
