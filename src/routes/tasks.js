const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify } = require('../utils/notify');
const { resolveMentions } = require('../utils/mentions');
const { deliverMessage } = require('../services/chatDelivery');
const {
  loadActor,
  actorLevelIn,
  isLeader,
  managesBusiness,
  nextApprovers,
} = require('../utils/org');
const {
  TASK_SELECT,
  decorateTask,
  getTaskForActor,
  recordActivity,
  broadcastTaskChange,
  clearWarnings,
  businessMemberIds,
} = require('../services/tasks');

const router = express.Router();

const STATUS_LABELS = {
  pending: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  completed: 'Completed',
  on_hold: 'On hold',
};

function parsePriority(value, fallback = 4) {
  const n = parseInt(value, 10);
  return n >= 1 && n <= 4 ? n : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function withActor(req, res) {
  const actor = await loadActor(req.user.id);
  if (!actor) {
    res.status(401).json({ error: 'User no longer exists' });
    return null;
  }
  return actor;
}

/** Is this user allowed to be assigned work in the business? (member or leadership) */
async function isAssignable(userId, businessId) {
  const result = await db.query(
    `SELECT u.id FROM users u
     LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $2
     WHERE u.id = $1 AND u.status != 'inactive'
       AND (ub.user_id IS NOT NULL OR u.org_level IS NOT NULL OR u.role IN ('admin', 'super_admin'))`,
    [userId, businessId]
  );
  return result.rows.length > 0;
}

async function notifyMentions(text, explicitIds, actor, task, exclude = []) {
  const mentioned = await resolveMentions(text, explicitIds);
  const ids = mentioned.map((m) => m.id).filter((id) => id !== actor.id && !exclude.includes(id));
  if (ids.length) {
    await notify(ids, {
      type: 'mention',
      title: `${actor.name} mentioned you`,
      body: `On task "${task.title}"`,
      data: { taskId: task.id },
    });
  }
  return ids;
}

// ---------------------------------------------------------------------------
// GET /api/tasks?view=all|mine|delegated&business_id&status&priority&q&assigned_user_id&page&limit
// ---------------------------------------------------------------------------
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;

    const { business_id, status, priority, q, assigned_user_id } = req.query;
    const view = req.query.view || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };

    const memberBizIds = [...actor.memberships.keys()];
    const managedBizIds = memberBizIds.filter((id) => managesBusiness(actor, id));

    // Visibility: leaders see everything; others see their own work, their business's
    // shared (unassigned) tasks, and everything in businesses they manage.
    if (!isLeader(actor)) {
      params.push(actor.id, memberBizIds, managedBizIds);
      const [me, member, managed] = [params.length - 2, params.length - 1, params.length];
      conditions.push(`(t.created_by = $${me} OR t.assigned_user_id = $${me}
        OR t.business_id = ANY($${managed}::int[])
        OR (t.business_id = ANY($${member}::int[]) AND t.assigned_user_id IS NULL))`);
    }

    if (view === 'mine') {
      params.push(actor.id, memberBizIds);
      const [me, member] = [params.length - 1, params.length];
      conditions.push(`(t.assigned_user_id = $${me}
        OR (t.assigned_user_id IS NULL AND t.business_id = ANY($${member}::int[]) AND t.created_by != $${me}))`);
    } else if (view === 'delegated') {
      params.push(actor.id);
      conditions.push(`(t.created_by = $${params.length} AND (t.assigned_user_id IS NULL OR t.assigned_user_id != $${params.length}))`);
    }

    if (business_id) add('t.business_id = ?', parseInt(business_id));
    if (assigned_user_id) add('t.assigned_user_id = ?', parseInt(assigned_user_id));
    if (priority) add('t.priority = ?', parsePriority(priority));
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      conditions.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
    }

    if (status === 'warned') {
      conditions.push('t.is_warned = true');
    } else if (status === 'overdue') {
      conditions.push(`t.due_date < CURRENT_DATE AND t.status NOT IN ('completed', 'on_hold')`);
    } else if (status === 'open') {
      conditions.push(`t.status != 'completed'`);
    } else if (status && STATUS_LABELS[status]) {
      add('t.status = ?', status);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.query(`SELECT COUNT(*) FROM tasks t ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const listParams = [...params, limit, offset];
    const result = await db.query(
      `${TASK_SELECT}
       ${whereClause}
       ORDER BY (t.status = 'completed'), t.priority ASC, t.due_date ASC NULLS LAST, t.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({
      tasks: result.rows.map((row) => decorateTask(row, actor)),
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/summary — badge counts for the current user
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const memberBizIds = [...actor.memberships.keys()];
    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status != 'completed' AND (assigned_user_id = $1
           OR (assigned_user_id IS NULL AND business_id = ANY($2::int[]) AND created_by != $1))) AS mine_open,
         COUNT(*) FILTER (WHERE status != 'completed' AND created_by = $1
           AND (assigned_user_id IS NULL OR assigned_user_id != $1)) AS delegated_open,
         COUNT(*) FILTER (WHERE status NOT IN ('completed', 'on_hold') AND due_date < CURRENT_DATE
           AND (assigned_user_id = $1 OR created_by = $1)) AS overdue,
         COUNT(*) FILTER (WHERE status = 'completed' AND completed_by = $1
           AND completed_at > NOW() - INTERVAL '7 days') AS completed_week
       FROM tasks`,
      [actor.id, memberBizIds]
    );
    const row = result.rows[0];
    res.json({
      mine_open: parseInt(row.mine_open) || 0,
      delegated_open: parseInt(row.delegated_open) || 0,
      overdue: parseInt(row.overdue) || 0,
      completed_week: parseInt(row.completed_week) || 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/assignees?business_id=X — people a task in this business can be assigned to
router.get('/assignees', authenticate, async (req, res, next) => {
  try {
    const businessId = parseInt(req.query.business_id);
    if (!businessId) return res.status(400).json({ error: 'business_id is required' });
    const result = await db.query(
      `SELECT u.id, u.name, u.username, u.profile_picture, u.org_level, u.role, u.title,
              ub.designation, ub.title AS membership_title
       FROM users u
       LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $1
       WHERE u.status != 'inactive'
         AND (ub.user_id IS NOT NULL OR u.org_level IS NOT NULL)
       ORDER BY u.org_level NULLS LAST, u.name`,
      [businessId]
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/share — { conversation_ids: [], task_ids: [], note? }
// Drops a task card into chats. The card is a snapshot; opening it still goes through
// the normal visibility rules, so sharing never grants access to the task itself.
router.post('/share', authenticate, async (req, res, next) => {
  try {
    const conversationIds = [...new Set((req.body.conversation_ids || []).map(Number).filter(Boolean))].slice(0, 20);
    const taskIds = [...new Set((req.body.task_ids || []).map(Number).filter(Boolean))].slice(0, 10);
    if (!conversationIds.length || !taskIds.length) {
      return res.status(400).json({ error: 'Pick at least one chat and one task' });
    }
    const actor = await withActor(req, res);
    if (!actor) return;

    const items = [];
    for (const id of taskIds) {
      const { task } = await getTaskForActor(id, actor);
      if (task) {
        items.push({
          id: task.id,
          title: task.title,
          description: task.description || '',
          status: task.status,
          priority: task.priority,
          due_date: task.due_date,
          business_name: task.business_name,
          assigned_user_name: task.assigned_user_name || null,
          created_by_name: task.created_by_name,
        });
      }
    }
    if (!items.length) return res.status(404).json({ error: 'Task not found or not visible to you' });

    const allowed = await db.query(
      `SELECT conversation_id FROM conversation_participants
       WHERE user_id = $1 AND conversation_id = ANY($2::int[])`,
      [req.user.id, conversationIds]
    );
    if (!allowed.rows.length) return res.status(403).json({ error: 'You are not in those chats' });

    const meta = { kind: 'task', task: items[0], tasks: items, shared_by: { id: actor.id, name: actor.name } };
    const note = sanitizeText(req.body.note, 2000) || null;
    const io = req.app.get('io');
    for (const row of allowed.rows) {
      await deliverMessage(io, {
        conversationId: row.conversation_id,
        sender: { id: actor.id, name: actor.name },
        body: note,
        meta,
      });
    }
    res.status(201).json({ shared: allowed.rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id — full task with activity timeline
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });

    const activity = await db.query(
      `SELECT ta.id, ta.kind, ta.body, ta.meta, ta.created_at, ta.user_id,
              u.name AS user_name, u.username AS user_username, u.profile_picture AS user_picture
       FROM task_activity ta
       LEFT JOIN users u ON u.id = ta.user_id
       WHERE ta.task_id = $1
       ORDER BY ta.created_at ASC, ta.id ASC`,
      [task.id]
    );
    res.json({ task, activity: activity.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/tasks — create (any business, optionally assigned to a person)
// ---------------------------------------------------------------------------
router.post('/', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;

    const title = sanitizeText(req.body.title, 200);
    const description = sanitizeText(req.body.description, 5000);
    const dueDate = parseDate(req.body.due_date);
    const priority = parsePriority(req.body.priority);
    let businessId = parseInt(req.body.business_id) || null;
    const assignedUserId = parseInt(req.body.assigned_user_id) || null;

    if (!title) return res.status(400).json({ error: 'Task title is required' });

    if (!businessId) {
      businessId = [...actor.memberships.keys()][0] || null;
      if (!businessId) return res.status(400).json({ error: 'Choose which business this task belongs to' });
    }

    const bizCheck = await db.query('SELECT id, name FROM businesses WHERE id = $1', [businessId]);
    if (bizCheck.rows.length === 0) return res.status(404).json({ error: 'Business not found' });
    const business = bizCheck.rows[0];

    if (assignedUserId && !(await isAssignable(assignedUserId, businessId))) {
      return res.status(400).json({ error: 'That person is not part of this business' });
    }

    // Raised from outside the business → remember which business asked for it.
    let sourceBusinessId = parseInt(req.body.source_business_id) || null;
    if (!sourceBusinessId && !actor.memberships.has(businessId) && !isLeader(actor)) {
      sourceBusinessId = [...actor.memberships.keys()][0] || null;
    }

    // Review before completion defaults to on when you hand work to someone else.
    const requiresApproval = req.body.requires_approval !== undefined
      ? !!req.body.requires_approval
      : !!(assignedUserId && assignedUserId !== actor.id);

    const inserted = await db.query(
      `INSERT INTO tasks (business_id, created_by, title, description, due_date, assigned_user_id,
                          priority, requires_approval, source_business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [businessId, actor.id, title, description || '', dueDate, assignedUserId, priority, requiresApproval, sourceBusinessId]
    );
    const taskId = inserted.rows[0].id;
    await recordActivity(taskId, actor.id, 'created', null, {
      assigned_user_id: assignedUserId,
      business_id: businessId,
    });

    const { task } = await getTaskForActor(taskId, actor);
    const priorityTag = priority === 1 ? '🔴 ' : priority === 2 ? '🟠 ' : '';

    let notified = [];
    if (assignedUserId && assignedUserId !== actor.id) {
      notified = [assignedUserId];
      await notify(notified, {
        type: 'task_assigned',
        title: `${priorityTag}${actor.name} assigned you a task`,
        body: `${title} · ${business.name}`,
        data: { taskId },
      });
    } else if (!assignedUserId) {
      notified = await businessMemberIds(businessId, { excludeId: actor.id });
      await notify(notified, {
        type: 'task_added',
        title: `${priorityTag}New task for ${business.name}`,
        body: `${title} — from ${actor.name}`,
        data: { taskId },
      });
    }
    await notifyMentions(description, req.body.mention_ids, actor, task, notified);

    broadcastTaskChange(taskId, businessId, 'created');
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/tasks/:id — edit details / reassign
// ---------------------------------------------------------------------------
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    if (!task.permissions.can_edit) {
      return res.status(403).json({ error: 'Only the person who created this task or someone senior to them can edit it' });
    }

    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 200) : task.title;
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    const description = req.body.description !== undefined ? sanitizeText(req.body.description, 5000) : task.description;
    const dueDate = req.body.due_date !== undefined ? parseDate(req.body.due_date) : task.due_date;
    const priority = req.body.priority !== undefined ? parsePriority(req.body.priority, task.priority) : task.priority;
    const requiresApproval = req.body.requires_approval !== undefined ? !!req.body.requires_approval : task.requires_approval;

    let assignedUserId = task.assigned_user_id;
    if (req.body.assigned_user_id !== undefined) {
      assignedUserId = parseInt(req.body.assigned_user_id) || null;
      if (assignedUserId && !(await isAssignable(assignedUserId, task.business_id))) {
        return res.status(400).json({ error: 'That person is not part of this business' });
      }
    }

    await db.query(
      `UPDATE tasks
       SET title = $1, description = $2, due_date = $3, priority = $4, assigned_user_id = $5,
           requires_approval = $6,
           last_overdue_notification_at = CASE WHEN due_date IS DISTINCT FROM $3::date THEN NULL ELSE last_overdue_notification_at END
       WHERE id = $7`,
      [title, description || '', dueDate, priority, assignedUserId, requiresApproval, task.id]
    );

    const changes = [];
    if (title !== task.title) changes.push('title');
    if ((description || '') !== (task.description || '')) changes.push('description');
    if (dueDate !== task.due_date) changes.push('due date');
    if (priority !== task.priority) changes.push('priority');
    if (changes.length) await recordActivity(task.id, actor.id, 'edited', changes.join(', '));

    if (assignedUserId !== task.assigned_user_id) {
      await recordActivity(task.id, actor.id, 'assigned', null, { from: task.assigned_user_id, to: assignedUserId });
      if (assignedUserId && assignedUserId !== actor.id) {
        await notify([assignedUserId], {
          type: 'task_assigned',
          title: `${actor.name} assigned you a task`,
          body: `${title} · ${task.business_name}`,
          data: { taskId: task.id },
        });
      }
    }
    await notifyMentions(
      description !== task.description ? description : '',
      req.body.mention_ids,
      actor,
      { id: task.id, title }
    );

    const updated = await getTaskForActor(task.id, actor);
    broadcastTaskChange(task.id, task.business_id);
    res.json({ task: updated.task });
  } catch (err) {
    next(err);
  }
});

/**
 * Move a task to a new status, applying the review flow:
 * completing a task that needs approval puts it "in review" for the person who
 * assigned it (or anyone senior to whoever finished it).
 */
async function changeStatus(req, res, actor, task, nextStatus) {
  const isHoldChange = nextStatus === 'on_hold' || task.status === 'on_hold';
  if (isHoldChange && !task.permissions.can_hold && !task.permissions.can_change_status) {
    return res.status(403).json({ error: 'You cannot put this task on hold' });
  }
  if (!isHoldChange && !task.permissions.can_change_status) {
    return res.status(403).json({ error: 'You cannot update this task' });
  }
  if (nextStatus === 'on_hold' && task.status === 'completed') {
    return res.status(400).json({ error: 'Cannot put a completed task on hold' });
  }

  // The creator, or anyone senior to the creator, can close a task outright;
  // everyone else sends it for review when the task asks for approval.
  let finalStatus = nextStatus;
  if (nextStatus === 'completed' && task.requires_approval && !task.permissions.can_edit) {
    finalStatus = 'in_review';
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (finalStatus === 'completed' || finalStatus === 'in_review') {
      // Review (in_review) clears any previous approval; a direct completion keeps it.
      await client.query(
        `UPDATE tasks SET status = $1, completed_by = $2, completed_at = NOW(),
           approved_by = CASE WHEN $4 THEN approved_by ELSE NULL END,
           approved_at = CASE WHEN $4 THEN approved_at ELSE NULL END
         WHERE id = $3`,
        [finalStatus, actor.id, task.id, finalStatus === 'completed']
      );
      if (finalStatus === 'completed') await clearWarnings(task.id, client);
    } else {
      await client.query(
        `UPDATE tasks SET status = $1, completed_by = NULL, completed_at = NULL, approved_by = NULL, approved_at = NULL
         WHERE id = $2`,
        [finalStatus, task.id]
      );
    }
    await recordActivity(task.id, actor.id, 'status', null, { from: task.status, to: finalStatus }, client);
    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK');
    throw txErr;
  } finally {
    client.release();
  }

  const involved = [task.created_by, task.assigned_user_id].filter((id) => id && id !== actor.id);
  if (finalStatus === 'in_review') {
    const reviewers = task.created_by !== actor.id
      ? [task.created_by]
      : await nextApprovers(task.business_id, actorLevelIn(actor, task.business_id), actor.id);
    await notify(reviewers, {
      type: 'approval_request',
      title: `✅ ${actor.name} finished a task — review it`,
      body: task.title,
      data: { taskId: task.id },
    }, { exclude: [actor.id] });
  } else if (finalStatus === 'completed') {
    await notify(involved, {
      type: 'task_completed',
      title: `🎉 Task completed by ${actor.name}`,
      body: task.title,
      data: { taskId: task.id },
    });
  } else if (finalStatus !== task.status) {
    await notify(involved, {
      type: 'task_status',
      title: `${actor.name} moved a task to ${STATUS_LABELS[finalStatus]}`,
      body: task.title,
      data: { taskId: task.id },
    });
  }

  const updated = await getTaskForActor(task.id, actor);
  broadcastTaskChange(task.id, task.business_id);
  return res.json({ task: updated.task });
}

// PUT /api/tasks/:id/status — { status: pending | in_progress | completed | on_hold }
router.put('/:id/status', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const nextStatus = req.body.status;
    if (!['pending', 'in_progress', 'completed', 'on_hold'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    return await changeStatus(req, res, actor, task, nextStatus);
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id/complete — toggle completed (kept for older clients)
router.put('/:id/complete', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    const nextStatus = task.status === 'completed' || task.status === 'in_review' ? 'pending' : 'completed';
    return await changeStatus(req, res, actor, task, nextStatus);
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id/hold — toggle on hold (kept for older clients)
router.put('/:id/hold', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    return await changeStatus(req, res, actor, task, task.status === 'on_hold' ? 'pending' : 'on_hold');
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/approve — accept a task that is in review
router.post('/:id/approve', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    if (!task.permissions.can_approve) return res.status(403).json({ error: 'You cannot approve this task' });

    const note = sanitizeText(req.body.note, 1000);
    await db.query(
      `UPDATE tasks SET status = 'completed', approved_by = $1, approved_at = NOW() WHERE id = $2`,
      [actor.id, task.id]
    );
    await clearWarnings(task.id);
    await recordActivity(task.id, actor.id, 'approved', note || null);
    await notify([task.completed_by, task.assigned_user_id], {
      type: 'task_approved',
      title: `👍 ${actor.name} approved your work`,
      body: task.title,
      data: { taskId: task.id },
    }, { exclude: [actor.id] });

    const updated = await getTaskForActor(task.id, actor);
    broadcastTaskChange(task.id, task.business_id);
    res.json({ task: updated.task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/reject — send a task in review back with a note
router.post('/:id/reject', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    if (!task.permissions.can_approve) return res.status(403).json({ error: 'You cannot review this task' });

    const note = sanitizeText(req.body.note, 1000);
    await db.query(
      `UPDATE tasks SET status = 'in_progress', completed_by = NULL, completed_at = NULL WHERE id = $1`,
      [task.id]
    );
    await recordActivity(task.id, actor.id, 'changes_requested', note || null);
    await notify([task.completed_by, task.assigned_user_id], {
      type: 'task_rejected',
      title: `↩️ ${actor.name} asked for changes`,
      body: note ? `${task.title}: ${note}` : task.title,
      data: { taskId: task.id },
    }, { exclude: [actor.id] });

    const updated = await getTaskForActor(task.id, actor);
    broadcastTaskChange(task.id, task.business_id);
    res.json({ task: updated.task });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/comments — { body, mention_ids? }
router.post('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });

    const body = sanitizeText(req.body.body, 3000);
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });

    const activity = await recordActivity(task.id, actor.id, 'comment', body);
    const mentioned = await notifyMentions(body, req.body.mention_ids, actor, task);
    await notify([task.created_by, task.assigned_user_id], {
      type: 'task_comment',
      title: `💬 ${actor.name} commented`,
      body: `${task.title}: ${body.length > 100 ? `${body.slice(0, 97)}…` : body}`,
      data: { taskId: task.id },
    }, { exclude: [actor.id, ...mentioned] });

    broadcastTaskChange(task.id, task.business_id, 'comment');
    res.status(201).json({
      activity: { ...activity, user_name: actor.name, user_username: actor.username },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tasks/:id/warn — warn the assignee (must be senior to them)
router.put('/:id/warn', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const message = sanitizeText(req.body.message, 1000);
    if (!message) return res.status(400).json({ error: 'Warning message is required' });

    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    if (task.status === 'completed') return res.status(400).json({ error: 'Cannot warn on a completed task' });
    if (task.status === 'on_hold') return res.status(400).json({ error: 'Cannot warn on a task that is on hold' });
    if (!task.permissions.can_warn) return res.status(403).json({ error: 'Only someone senior to the assignee can send a warning' });

    // Unassigned task: warn everyone in the business who is junior to the sender.
    const targets = (task.assigned_user_id
      ? [task.assigned_user_id]
      : await businessMemberIds(task.business_id, { belowLevel: actorLevelIn(actor, task.business_id) })
    ).filter((id) => id !== actor.id);
    if (targets.length === 0) return res.status(400).json({ error: 'No users to warn for this task' });

    await db.query('UPDATE tasks SET is_warned = true WHERE id = $1', [task.id]);
    for (const uid of targets) {
      await db.query(
        'INSERT INTO warnings (task_id, user_id, sent_by, message) VALUES ($1, $2, $3, $4)',
        [task.id, uid, actor.id, message]
      );
      await db.query("UPDATE users SET status = 'warned' WHERE id = $1 AND status = 'active'", [uid]);
    }
    await recordActivity(task.id, actor.id, 'warning', message);
    await notify(targets, {
      type: 'warning',
      title: `⚠️ Warning from ${actor.name}`,
      body: `${task.title}: ${message}`,
      data: { taskId: task.id },
    });

    broadcastTaskChange(task.id, task.business_id);
    res.json({ message: 'Warning sent successfully' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id — creator or someone senior to the creator
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    if (!task.permissions.can_delete) {
      return res.status(403).json({
        error: 'Only the person who created this task or someone senior can delete it. You can request deletion instead.',
        can_request: task.permissions.can_request_delete,
      });
    }

    await clearWarnings(task.id);
    await db.query('DELETE FROM tasks WHERE id = $1', [task.id]);
    await notify([task.assigned_user_id, task.created_by], {
      type: 'task_deleted',
      title: `🗑️ ${actor.name} deleted a task`,
      body: task.title,
      data: {},
    }, { exclude: [actor.id] });

    broadcastTaskChange(task.id, task.business_id, 'deleted');
    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:id/request-delete — { reason } → goes up the chain for approval
router.post('/:id/request-delete', authenticate, async (req, res, next) => {
  try {
    const actor = await withActor(req, res);
    if (!actor) return;
    const { task, error, status } = await getTaskForActor(req.params.id, actor);
    if (error) return res.status(status).json({ error });
    if (task.permissions.can_delete) return res.status(400).json({ error: 'You can delete this task directly' });
    if (task.pending_delete_request_id) return res.status(409).json({ error: 'A deletion request is already pending' });

    const reason = sanitizeText(req.body.reason, 1000);
    const myLevel = actorLevelIn(actor, task.business_id);
    const inserted = await db.query(
      `INSERT INTO approvals (kind, task_id, business_id, requested_by, requester_level, reason, subject)
       VALUES ('task_deletion', $1, $2, $3, $4, $5, $6) RETURNING *`,
      [task.id, task.business_id, actor.id, myLevel, reason || null, task.title]
    );
    await recordActivity(task.id, actor.id, 'delete_requested', reason || null);

    const approvers = new Set(await nextApprovers(task.business_id, myLevel, actor.id));
    approvers.add(task.created_by);
    await notify([...approvers], {
      type: 'approval_request',
      title: `🗑️ ${actor.name} asked to delete a task`,
      body: reason ? `${task.title} — "${reason}"` : task.title,
      data: { taskId: task.id, approvalId: inserted.rows[0].id },
    }, { exclude: [actor.id] });

    broadcastTaskChange(task.id, task.business_id);
    res.status(201).json({ approval: inserted.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
