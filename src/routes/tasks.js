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

    // Non-admin users can only see tasks in businesses they're assigned to
    // and only tasks assigned to them or unassigned (assigned_user_id IS NULL)
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      conditions.push(`EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = $${paramIdx++} AND ub.business_id = t.business_id)`);
      params.push(req.user.id);
      conditions.push(`(t.assigned_user_id IS NULL OR t.assigned_user_id = $${paramIdx++})`);
      params.push(req.user.id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT t.*,
         u.name AS created_by_name,
         c.name AS completed_by_name,
         b.name AS business_name,
         b.type AS business_type,
         a.name AS assigned_user_name,
         w.message AS warning_message,
         w.created_at AS warning_created_at
       FROM tasks t
       JOIN users u ON t.created_by = u.id
       LEFT JOIN users c ON t.completed_by = c.id
       LEFT JOIN users a ON t.assigned_user_id = a.id
       JOIN businesses b ON t.business_id = b.id
       LEFT JOIN LATERAL (
         SELECT message, created_at FROM warnings
         WHERE task_id = t.id
         ORDER BY created_at DESC LIMIT 1
       ) w ON true
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
    const { title, description, due_date, business_id, assigned_user_id } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    let taskBusinessId = business_id;

    // Non-admin users can only create tasks in businesses they're assigned to
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      if (taskBusinessId) {
        const accessCheck = await db.query(
          'SELECT 1 FROM user_businesses WHERE user_id = $1 AND business_id = $2',
          [req.user.id, taskBusinessId]
        );
        if (accessCheck.rows.length === 0) {
          return res.status(403).json({ error: 'You can only create tasks in your assigned businesses' });
        }
      } else {
        const userBiz = await db.query(
          'SELECT business_id FROM user_businesses WHERE user_id = $1 LIMIT 1',
          [req.user.id]
        );
        if (userBiz.rows.length === 0) {
          return res.status(403).json({ error: 'You must be assigned to a business to create tasks' });
        }
        taskBusinessId = userBiz.rows[0].business_id;
      }
    }

    if (!taskBusinessId) {
      return res.status(400).json({ error: 'business_id is required' });
    }

    // Verify business exists
    const bizCheck = await db.query('SELECT id FROM businesses WHERE id = $1', [taskBusinessId]);
    if (bizCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    // Validate assigned_user_id if provided
    let assignedUserId = null;
    if (assigned_user_id) {
      const userCheck = await db.query(
        `SELECT u.id FROM users u
         JOIN user_businesses ub ON ub.user_id = u.id
         WHERE u.id = $1 AND ub.business_id = $2 AND u.role = $3`,
        [assigned_user_id, taskBusinessId, 'user']
      );
      if (userCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Assigned user not found in this business' });
      }
      assignedUserId = assigned_user_id;
    }

    const result = await db.query(
      `INSERT INTO tasks (business_id, created_by, title, description, due_date, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [taskBusinessId, req.user.id, title.trim(), description || '', due_date || null, assignedUserId]
    );

    // Create notifications:
    // - Admins/super_admins always get notified when a task is created
    // - If assigned to a specific user, notify only that user
    // - If unassigned, notify all regular users in the business
    const admins = await db.query(
      `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND id != $1`,
      [req.user.id]
    );
    for (const admin of admins.rows) {
      await db.query(
        `INSERT INTO notifications (user_id, type, message)
         VALUES ($1, 'task_added', $2)`,
        [admin.id, `New task created: "${title.trim()}"`]
      );
    }

    if (assignedUserId) {
      await db.query(
        `INSERT INTO notifications (user_id, type, message)
         VALUES ($1, 'task_added', $2)`,
        [assignedUserId, `New task assigned to you: "${title.trim()}"`]
      );
    } else {
      const usersInBiz = await db.query(
        `SELECT u.id FROM users u
         JOIN user_businesses ub ON ub.user_id = u.id
         WHERE ub.business_id = $1 AND u.role = $2 AND u.id != $3`,
        [taskBusinessId, 'user', req.user.id]
      );
      for (const u of usersInBiz.rows) {
        await db.query(
          `INSERT INTO notifications (user_id, type, message)
           VALUES ($1, 'task_added', $2)`,
          [u.id, `New task added: "${title.trim()}"`]
        );
      }
    }

    res.status(201).json({ task: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id — edit task details
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, due_date } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }

    const taskResult = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Non-admin users can only edit tasks they can access
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      const accessCheck = await db.query(
        'SELECT 1 FROM user_businesses WHERE user_id = $1 AND business_id = $2',
        [req.user.id, task.business_id]
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You can only edit tasks in your business' });
      }
      if (task.assigned_user_id && task.assigned_user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only edit tasks assigned to you' });
      }
    }

    const result = await db.query(
      `UPDATE tasks
       SET title = $1, description = $2, due_date = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [title.trim(), description || '', due_date || null, id]
    );

    res.json({ task: result.rows[0] });
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

    // Non-admin users can only toggle tasks in their businesses
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      const accessCheck = await db.query(
        'SELECT 1 FROM user_businesses WHERE user_id = $1 AND business_id = $2',
        [req.user.id, task.business_id]
      );
      if (accessCheck.rows.length === 0) {
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

    // Send notifications when task is completed (not when un-completed)
    if (newStatus === 'completed') {
      const completerResult = await db.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
      const completerName = completerResult.rows[0]?.name || 'Someone';

      // Notify all admins and super_admins
      const admins = await db.query(
        `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND id != $1`,
        [req.user.id]
      );
      for (const admin of admins.rows) {
        await db.query(
          `INSERT INTO notifications (user_id, type, message)
           VALUES ($1, 'task_completed', $2)`,
          [admin.id, `Task "${task.title}" completed by ${completerName}`]
        );
      }

      // Remove warnings for this task and reset user status if no remaining warnings
      if (task.is_warned) {
        const warnedUsers = await db.query(
          'SELECT DISTINCT user_id FROM warnings WHERE task_id = $1',
          [id]
        );
        await db.query('DELETE FROM warnings WHERE task_id = $1', [id]);
        await db.query('UPDATE tasks SET is_warned = false WHERE id = $1', [id]);
        for (const w of warnedUsers.rows) {
          const remaining = await db.query(
            'SELECT 1 FROM warnings WHERE user_id = $1 LIMIT 1',
            [w.user_id]
          );
          if (remaining.rows.length === 0) {
            await db.query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'warned'", [w.user_id]);
          }
        }
      }

      // Notify users based on assignment
      if (task.assigned_user_id) {
        // Task assigned to a specific user — notify only them (if they didn't complete it themselves)
        if (task.assigned_user_id !== req.user.id) {
          await db.query(
            `INSERT INTO notifications (user_id, type, message)
             VALUES ($1, 'task_completed', $2)`,
            [task.assigned_user_id, `Task "${task.title}" completed by ${completerName}`]
          );
        }
      } else {
        // Task for all users in business — notify all regular users in that business (except completer)
        const bizUsers = await db.query(
          `SELECT u.id FROM users u
           JOIN user_businesses ub ON ub.user_id = u.id
           WHERE ub.business_id = $1 AND u.role = 'user' AND u.id != $2`,
          [task.business_id, req.user.id]
        );
        for (const u of bizUsers.rows) {
          await db.query(
            `INSERT INTO notifications (user_id, type, message)
             VALUES ($1, 'task_completed', $2)`,
            [u.id, `Task "${task.title}" completed by ${completerName}`]
          );
        }
      }
    }

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

    // Determine who to warn:
    // - If task has assigned_user_id, warn that specific user only
    // - Otherwise warn all regular users in the task's business
    let warnUserIds = [];
    if (task.assigned_user_id) {
      warnUserIds = [task.assigned_user_id];
    } else {
      const bizUsers = await db.query(
        `SELECT u.id FROM users u
         JOIN user_businesses ub ON ub.user_id = u.id
         WHERE ub.business_id = $1 AND u.role = 'user'`,
        [task.business_id]
      );
      warnUserIds = bizUsers.rows.map((r) => r.id);
    }

    if (warnUserIds.length === 0) {
      return res.status(400).json({ error: 'No users to warn for this task' });
    }

    // Mark task as warned
    await db.query('UPDATE tasks SET is_warned = true WHERE id = $1', [id]);

    // Create warning records and notifications for each target user
    for (const uid of warnUserIds) {
      await db.query(
        `INSERT INTO warnings (task_id, user_id, sent_by, message)
         VALUES ($1, $2, $3, $4)`,
        [id, uid, req.user.id, message.trim()]
      );

      await db.query(
        `INSERT INTO notifications (user_id, type, message)
         VALUES ($1, 'warning', $2)`,
        [uid, `Warning on task "${task.title}": ${message.trim()}`]
      );

      // Update user status to warned
      await db.query("UPDATE users SET status = 'warned' WHERE id = $1", [uid]);
    }

    res.json({ message: 'Warning sent successfully' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get task to check visibility/permissions
    const taskResult = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Non-admin users can only delete tasks they can see in their businesses
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      const accessCheck = await db.query(
        'SELECT 1 FROM user_businesses WHERE user_id = $1 AND business_id = $2',
        [req.user.id, task.business_id]
      );
      if (accessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You can only delete tasks in your business' });
      }
      if (task.assigned_user_id && task.assigned_user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only delete tasks assigned to you' });
      }
    }

    // Remove warnings for this task and reset user status if no remaining warnings
    if (task.is_warned) {
      const warnedUsers = await db.query(
        'SELECT DISTINCT user_id FROM warnings WHERE task_id = $1',
        [id]
      );
      await db.query('DELETE FROM warnings WHERE task_id = $1', [id]);
      for (const w of warnedUsers.rows) {
        const remaining = await db.query(
          'SELECT 1 FROM warnings WHERE user_id = $1 LIMIT 1',
          [w.user_id]
        );
        if (remaining.rows.length === 0) {
          await db.query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'warned'", [w.user_id]);
        }
      }
    }

    await db.query('DELETE FROM tasks WHERE id = $1', [id]);
    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
