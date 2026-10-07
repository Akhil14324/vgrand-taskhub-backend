const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { notify, emitToUsers } = require('../utils/notify');
const { resolveMentions } = require('../utils/mentions');
const { deliverMessage } = require('../services/chatDelivery');
const { todayInAppZone, nextOccurrence, APP_TIMEZONE } = require('../utils/recurrence');
const { completionSnapshot } = require('../utils/timeline');
const {
  loadActor, actorLevelIn, isLeader, managesBusiness, nextApprovers,
} = require('../utils/org');
const {
  listTodos, getTodoFor, memberIds, audienceIds, descendantIds, depthOf, heightOf,
} = require('../services/todoQueries');
const {
  MAX_DEPTH, isAssignable, businessMemberIds, clearWarnings, reviewersFor,
} = require('../services/todoGovernance');
const {
  logEvent, setStatus, resolveOpenBlockers, assignTodo, releaseDependents,
} = require('../services/todoTimeline');

const router = express.Router();

const LIST_COLORS = ['indigo', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];
const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
// Minutes before the due time at which an extra reminder may fire.
const REMINDER_OFFSETS = [5, 10, 15, 30, 60, 120, 1440, 2880];
const FILTER_DUE = ['any', 'overdue', 'today', 'week', 'nodate'];
const FILTER_ASSIGNED = ['any', 'mine', 'others', 'shared'];

function parsePriority(value, fallback = 4) {
  const n = parseInt(value, 10);
  return n >= 1 && n <= 4 ? n : fallback;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseTime(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Labels are lower-case words (letters, digits, - and _), at most 10 per to-do. */
function parseLabels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    const label = String(raw || '').toLowerCase().replace(/^[#+@]+/, '').replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= 10) break;
  }
  return out;
}

function parseDuration(value) {
  if (value === null || value === '' || value === undefined) return null;
  const n = parseInt(value, 10);
  return n >= 1 && n <= 14400 ? n : null;
}

function parseOffsets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => REMINDER_OFFSETS.includes(n)))].sort((a, b) => a - b);
}

/** Saved filters are evaluated on the client; only known keys and values are stored. */
function parseFilterConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const listId = c.list_id === 'inbox' ? 'inbox' : (parseInt(c.list_id, 10) || null);
  return {
    due: FILTER_DUE.includes(c.due) ? c.due : 'any',
    priorities: [...new Set((Array.isArray(c.priorities) ? c.priorities : []).map(Number).filter((p) => p >= 1 && p <= 4))],
    labels: parseLabels(c.labels),
    list_id: listId,
    assigned: FILTER_ASSIGNED.includes(c.assigned) ? c.assigned : 'any',
  };
}

async function actorOf(req, res) {
  const actor = await loadActor(req.user.id);
  if (!actor) {
    res.status(401).json({ error: 'User no longer exists' });
    return null;
  }
  return actor;
}

/** Load a to-do the caller may see, or answer 404. */
async function visibleTodo(req, res, actor) {
  const todo = await getTodoFor(req.params.id, actor.id, actor);
  if (!todo) {
    res.status(404).json({ error: 'To-do not found' });
    return null;
  }
  return todo;
}

async function ownsList(listId, userId) {
  if (!listId) return true;
  const result = await db.query('SELECT 1 FROM todo_lists WHERE id = $1 AND owner_id = $2', [listId, userId]);
  return result.rows.length > 0;
}

/**
 * Where a to-do sits in *my* lists. A section implies its list. Returns { listId, sectionId }
 * or { error } when the list/section is not mine.
 */
async function resolvePlacement(userId, listId, sectionId) {
  if (sectionId) {
    const result = await db.query(
      'SELECT s.id, s.list_id FROM todo_sections s WHERE s.id = $1 AND s.owner_id = $2',
      [sectionId, userId]
    );
    if (!result.rows.length) return { error: 'Section not found' };
    return { listId: result.rows[0].list_id, sectionId };
  }
  if (!(await ownsList(listId, userId))) return { error: 'List not found' };
  return { listId: listId || null, sectionId: null };
}

/** Put someone on a to-do (and optionally everything below it) without touching their list placement. */
async function ensureMember(todoId, userId, addedBy, { withDescendants = false } = {}) {
  const ids = [todoId, ...(withDescendants ? await descendantIds(todoId) : [])];
  await db.query(
    `INSERT INTO todo_members (todo_id, user_id, list_id, added_by)
     SELECT d, $2::int, NULL::int, $3::int FROM unnest($1::int[]) AS d ON CONFLICT DO NOTHING`,
    [ids, userId, addedBy]
  );
}

/** Add @mentioned people to a to-do (and everything below it) and tell them about it. Returns added user ids. */
async function addMentionedMembers(todo, text, explicitIds, actor, { quietFor = null } = {}) {
  const mentioned = await resolveMentions(text, explicitIds);
  const existing = new Set(await memberIds(todo.id));
  const added = mentioned.filter((m) => !existing.has(m.id) && m.id !== actor.id);
  const subject = (await db.query('SELECT assignee_id FROM todos WHERE id = $1', [todo.id])).rows[0]?.assignee_id;
  for (const m of added) {
    await ensureMember(todo.id, m.id, actor.id, { withDescendants: true });
    await logEvent({ todoId: todo.id, userId: actor.id, subjectId: subject, kind: 'shared', to: m.name, meta: { user_id: m.id } });
  }
  if (added.length) {
    await notify(added.map((m) => m.id).filter((id) => id !== quietFor), {
      type: 'todo_shared',
      title: `${actor.name} added a to-do for you`,
      body: todo.title,
      data: { todoId: todo.id },
    });
  }
  return added.map((m) => m.id);
}

/** Everyone on the parent also sits on its new sub-task; my own copy keeps the parent's placement. */
async function attachSubtaskMembers(subtaskId, parent, userId) {
  await db.query(
    `INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by)
     SELECT $1::int, m.user_id, CASE WHEN m.user_id = $3::int THEN $4::int END, CASE WHEN m.user_id = $3::int THEN $5::int END, $3::int
     FROM todo_members m WHERE m.todo_id = $2
     ON CONFLICT DO NOTHING`,
    [subtaskId, parent.id, userId, parent.list_id, parent.section_id]
  );
}

/** Tell everyone who can see the to-do that it changed. */
async function announce(todoId, action = 'updated') {
  emitToUsers(await audienceIds(todoId), 'todo:changed', { todoId: Number(todoId), action });
}

function announceTo(userIds, todoId, action = 'updated') {
  emitToUsers(userIds, 'todo:changed', { todoId: Number(todoId), action });
}

// GET /api/todos — my lists, every to-do on them, and the business to-dos I can see
// (open ones, and finished ones from the last 30 days or whose date is still recent)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const manageable = new Set([...actor.memberships.keys()].filter((id) => managesBusiness(actor, id)));
    const [lists, sections, filters, todos, businesses] = await Promise.all([
      db.query('SELECT * FROM todo_lists WHERE owner_id = $1 ORDER BY sort_order, id', [actor.id]),
      db.query('SELECT s.* FROM todo_sections s WHERE s.owner_id = $1 ORDER BY s.sort_order, s.id', [actor.id]),
      db.query('SELECT * FROM todo_filters WHERE owner_id = $1 ORDER BY sort_order, id', [actor.id]),
      listTodos(actor.id, {
        actor,
        where: `(t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '30 days'
                 OR t.due_date >= CURRENT_DATE - 30
                 OR EXISTS (SELECT 1 FROM todos p WHERE p.id = t.parent_id AND p.is_done = FALSE))`,
        tail: `ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.due_time ASC NULLS LAST, t.priority ASC, t.created_at DESC
               LIMIT 3000`,
      }),
      db.query(
        `SELECT b.id, b.name, b.type, b.color FROM businesses b
         WHERE $1::boolean OR b.id = ANY($2::int[]) ORDER BY b.sort_order, b.name`,
        [isLeader(actor), [...actor.memberships.keys()]]
      ),
    ]);
    res.json({
      lists: lists.rows,
      sections: sections.rows,
      filters: filters.rows,
      todos,
      businesses: businesses.rows.map((b) => ({
        ...b,
        can_manage: isLeader(actor) || manageable.has(b.id),
        my_level: actorLevelIn(actor, b.id),
      })),
      today: todayInAppZone(),
      timezone: APP_TIMEZONE,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/completed?before=<ISO time> — completion history, newest first, 40 per page.
// Sub-tasks that were completed together with their parent are left out.
router.get('/completed', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const before = req.query.before && !Number.isNaN(Date.parse(req.query.before))
      ? new Date(req.query.before).toISOString()
      : null;
    const rows = await listTodos(actor.id, {
      actor,
      where: `t.is_done = TRUE AND t.done_at IS NOT NULL
              AND (tm.user_id IS NOT NULL OR t.done_by = $1)
              AND ($5::timestamptz IS NULL OR t.done_at < $5)
              AND NOT EXISTS (SELECT 1 FROM todos p WHERE p.id = t.parent_id AND p.is_done = TRUE)`,
      params: [before],
      tail: 'ORDER BY t.done_at DESC LIMIT 41',
    });
    res.json({ todos: rows.slice(0, 40), has_more: rows.length > 40 });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/insights — completions per day for the last 7 days + streak + daily goal
router.get('/insights', authenticate, async (req, res, next) => {
  try {
    const [result, goalRow] = await Promise.all([
      db.query(
        `SELECT (done_at AT TIME ZONE $2)::date::text AS day, COUNT(*)::int AS count FROM todos
         WHERE done_by = $1 AND done_at > NOW() - INTERVAL '90 days'
         GROUP BY 1`,
        [req.user.id, APP_TIMEZONE]
      ),
      db.query('SELECT todo_daily_goal FROM users WHERE id = $1', [req.user.id]),
    ]);
    const byDay = new Map(result.rows.map((r) => [r.day, r.count]));
    const today = todayInAppZone();
    const shift = (ymd, delta) => {
      const [y, m, d] = ymd.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + delta));
      return dt.toISOString().slice(0, 10);
    };

    const week = [];
    for (let i = 6; i >= 0; i--) {
      const day = shift(today, -i);
      week.push({ day, count: byDay.get(day) || 0 });
    }
    // A streak survives until the end of today even if nothing is done yet today.
    let streak = 0;
    let cursor = byDay.get(today) ? today : shift(today, -1);
    while (byDay.get(cursor)) {
      streak += 1;
      cursor = shift(cursor, -1);
    }
    res.json({
      week,
      streak,
      today_count: byDay.get(today) || 0,
      today,
      goal: goalRow.rows[0]?.todo_daily_goal || 5,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/todos/goal — { goal } daily completion target (declared before /:id)
router.put('/goal', authenticate, async (req, res, next) => {
  try {
    const goal = parseInt(req.body.goal, 10);
    if (!(goal >= 1 && goal <= 50)) return res.status(400).json({ error: 'Pick a goal between 1 and 50' });
    await db.query('UPDATE users SET todo_daily_goal = $1 WHERE id = $2', [goal, req.user.id]);
    res.json({ goal });
  } catch (err) {
    next(err);
  }
});

// GET /api/todos/assignees?business_id=X — people business work can be given to
router.get('/assignees', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const businessId = parseInt(req.query.business_id, 10);
    if (!businessId) return res.status(400).json({ error: 'business_id is required' });
    if (!isLeader(actor) && !actor.memberships.has(businessId)) return res.json({ users: [] });
    const result = await db.query(
      `SELECT u.id, u.name, u.username, u.profile_picture, u.org_level, u.role, u.title,
              ub.designation, ub.title AS membership_title
       FROM users u
       LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $1
       WHERE u.status != 'inactive' AND (ub.user_id IS NOT NULL OR u.org_level IS NOT NULL)
       ORDER BY u.org_level NULLS LAST, u.name`,
      [businessId]
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/board-order — { ids: [...] } the order of cards on a board, for me only
router.post('/board-order', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 500);
    if (!ids.length) return res.json({ ordered: 0 });
    // Only cards I can see.
    const visible = await listTodos(actor.id, { actor, where: 't.id = ANY($5::int[])', params: [ids] });
    const allowed = new Set(visible.map((t) => t.id));
    const ordered = ids.filter((id) => allowed.has(id));
    if (!ordered.length) return res.json({ ordered: 0 });
    await db.query(
      `INSERT INTO todo_board_order (user_id, todo_id, position)
       SELECT $1::int, o.id, o.ord::int FROM unnest($2::int[]) WITH ORDINALITY AS o(id, ord)
       ON CONFLICT (user_id, todo_id) DO UPDATE SET position = EXCLUDED.position`,
      [actor.id, ordered]
    );
    res.json({ ordered: ordered.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/reorder — { ids: [...] } puts these to-dos in that order in *my* lists
router.post('/reorder', authenticate, async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))].slice(0, 500);
    if (!ids.length) return res.json({ reordered: 0 });
    await db.query(
      `UPDATE todo_members tm SET sort_order = o.ord::int
       FROM unnest($2::int[]) WITH ORDINALITY AS o(id, ord)
       WHERE tm.todo_id = o.id AND tm.user_id = $1`,
      [req.user.id, ids]
    );
    res.json({ reordered: ids.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos — { title, notes?, due_date?, due_time?, priority?, list_id?, section_id?, recurrence?,
//                     mention_ids?, parent_id?, labels?, deadline_date?, duration_minutes?, reminder_offsets?,
//                     business_id?, assign_to?, delegate_to?, requires_approval?, source_business_id? }
// delegate_to (personal only): hand the to-do to another person. It goes to their list, not mine; the
// response has no `todo`, only `assigned_to`.
// With a business_id it is a business to-do: set directly by someone who manages that business, otherwise
// proposed for review. Sub-tasks (any depth) belong to the same business as their parent.
/**
 * Creates one to-do (or sub-task) for `actor` from a request-shaped body; shared by POST / and templates.
 * Returns { status, error } on a refusal, otherwise { status: 201, todo }. `quiet` skips the business
 * notifications and the realtime announcement (a template announces once, at the end).
 */
async function createTodoCore(actor, body, { quiet = false } = {}) {
  const title = sanitizeText(body.title, 500);
  if (!title) return { status: 400, error: 'What needs to be done?' };
  const notes = sanitizeText(body.notes, 5000);

  let parent = null;
  const parentId = parseInt(body.parent_id, 10) || null;
  if (parentId) {
    parent = await getTodoFor(parentId, actor.id, actor);
    if (!parent) return { status: 404, error: 'To-do not found' };
    if (!parent.permissions.can_add_subtask) return { status: 403, error: 'You cannot add to this to-do' };
    if ((await depthOf(parent.id)) + 1 > MAX_DEPTH) {
      return { status: 400, error: `Sub-tasks can go ${MAX_DEPTH} levels deep` };
    }
  }

  const businessId = parent ? parent.business_id : (parseInt(body.business_id, 10) || null);
  let business = null;
  if (businessId) {
    business = (await db.query('SELECT id, name FROM businesses WHERE id = $1', [businessId])).rows[0];
    if (!business) return { status: 404, error: 'Business not found' };
  }

  // "Assign": hand a personal to-do to anyone else. It lands in that person's
  // Inbox and stays off the giver's own list.
  const delegateId = !businessId && !parent ? (parseInt(body.delegate_to, 10) || null) : null;
  let delegate = null;
  if (delegateId) {
    if (delegateId === actor.id) return { status: 400, error: 'Pick someone else to assign this to' };
    delegate = await loadActor(delegateId);
    if (!delegate || delegate.status === 'inactive') return { status: 404, error: 'Person not found' };
  }

  const place = businessId || delegate
    ? { listId: null, sectionId: null }
    : await resolvePlacement(actor.id, parseInt(body.list_id, 10) || null, parseInt(body.section_id, 10) || null);
  if (place.error) return { status: 404, error: place.error };

  const assignTo = parseInt(body.assign_to ?? body.assigned_user_id, 10) || null;
  if (businessId && assignTo && !(await isAssignable(assignTo, businessId))) {
    return { status: 400, error: 'That person is not part of this business' };
  }

  let reviewState = 'accepted';
  if (parent) reviewState = parent.review_state;
  else if (businessId && !(isLeader(actor) || managesBusiness(actor, businessId))) reviewState = 'proposed';

  let assigneeId = delegate ? delegate.id : actor.id;
  if (businessId) {
    if (assignTo) assigneeId = assignTo;
    else if (parent) assigneeId = parent.assignee_id || null;
    else assigneeId = reviewState === 'proposed' ? actor.id : null;
  }

  const topLevelBusiness = !!businessId && !parent;
  const requiresApproval = topLevelBusiness
    ? (body.requires_approval !== undefined
      ? !!body.requires_approval
      : !!(assigneeId && assigneeId !== actor.id))
    : false;
  let sourceBusinessId = topLevelBusiness ? (parseInt(body.source_business_id, 10) || null) : null;
  if (topLevelBusiness && !sourceBusinessId && !actor.memberships.has(businessId) && !isLeader(actor)) {
    sourceBusinessId = [...actor.memberships.keys()][0] || null;
  }

  const recurrence = RECURRENCES.includes(body.recurrence) ? body.recurrence : null;
  const dueDate = parseDate(body.due_date) || (recurrence ? todayInAppZone() : null);
  const dueTime = parseTime(body.due_time);

  const inserted = await db.query(
    `INSERT INTO todos (created_by, title, notes, due_date, due_time, priority, recurrence,
                        parent_id, labels, deadline_date, duration_minutes, reminder_offsets,
                        assignee_id, assigned_at, business_id, source_business_id, requires_approval, review_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::int,
             CASE WHEN $13::int IS NOT NULL THEN NOW() END, $14, $15, $16, $17)
     RETURNING id, title, business_id`,
    [
      actor.id, title, notes || '', dueDate, dueTime, parsePriority(body.priority), recurrence,
      parent ? parent.id : null, parseLabels(body.labels), parseDate(body.deadline_date),
      parseDuration(body.duration_minutes), dueTime ? parseOffsets(body.reminder_offsets) : [],
      assigneeId, businessId, sourceBusinessId, requiresApproval, reviewState,
    ]
  );
  const todo = inserted.rows[0];

  if (parent) {
    await attachSubtaskMembers(todo.id, parent, actor.id);
    await ensureMember(todo.id, actor.id, actor.id);
    if (assigneeId) await ensureMember(todo.id, assigneeId, actor.id);
  } else if (businessId) {
    await ensureMember(todo.id, actor.id, actor.id);
    if (assigneeId && assigneeId !== actor.id) await ensureMember(todo.id, assigneeId, actor.id);
  } else if (delegate) {
    await db.query(
      'INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by) VALUES ($1, $2, NULL, NULL, $3)',
      [todo.id, delegate.id, actor.id]
    );
  } else {
    await db.query(
      'INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by) VALUES ($1, $2, $3, $4, $2)',
      [todo.id, actor.id, place.listId, place.sectionId]
    );
  }

  await logEvent({
    todoId: todo.id, userId: actor.id, subjectId: assigneeId || actor.id, kind: 'created',
    meta: { title, parent_id: parent ? parent.id : null, business_id: businessId, review_state: reviewState },
  });

  if (delegate) {
    await notify([delegate.id], {
      type: 'todo_assigned',
      title: `${parsePriority(body.priority) === 1 ? 'Urgent: ' : ''}${actor.name} assigned you a to-do`,
      body: title,
      data: { todoId: todo.id },
    });
    if (!quiet) await announce(todo.id, 'created');
    return { status: 201, todo: null, id: todo.id, assigned_to: { id: delegate.id, name: delegate.name } };
  }

  const added = await addMentionedMembers(todo, `${title} ${notes || ''}`, body.mention_ids, actor, {
    quietFor: assignTo || null,
  });

  if (!businessId) {
    // "Assign to @ravi": the person who is accountable, not just a collaborator.
    if (assignTo && added.includes(assignTo)) await assignTodo(todo, assignTo, actor);
  } else if (!quiet) {
    const urgent = parsePriority(body.priority) === 1 ? 'Urgent: ' : '';
    if (reviewState === 'proposed') {
      const approvers = await nextApprovers(businessId, actorLevelIn(actor, businessId), actor.id);
      await notify(approvers, {
        type: 'todo_proposed',
        title: `${actor.name} proposed a task`,
        body: `${title} · ${business.name}`,
        data: { todoId: todo.id },
      });
    } else if (assigneeId && assigneeId !== actor.id) {
      await notify([assigneeId], {
        type: 'todo_assigned',
        title: `${urgent}${actor.name} assigned you a task`,
        body: `${title} · ${business.name}`,
        data: { todoId: todo.id },
      });
    } else if (!assigneeId && !parent) {
      await notify(await businessMemberIds(businessId, { excludeId: actor.id }), {
        type: 'todo_added',
        title: `${urgent}New task for ${business.name}`,
        body: `${title} — from ${actor.name}`,
        data: { todoId: todo.id },
      });
    }
  }

  if (!quiet) await announce(todo.id, 'created');
  return { status: 201, todo: await getTodoFor(todo.id, actor.id, actor), id: todo.id };
}

router.post('/', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const out = await createTodoCore(actor, req.body);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(201).json({ todo: out.todo, assigned_to: out.assigned_to || undefined });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/import — { items: [{ title, notes?, due_date?, priority? }], list_id? }
// Copies to-dos someone shared in chat into my own list.
router.post('/import', authenticate, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    const listId = parseInt(req.body.list_id) || null;
    if (!(await ownsList(listId, req.user.id))) return res.status(404).json({ error: 'List not found' });
    let created = 0;
    for (const item of items) {
      const title = sanitizeText(item.title, 500);
      if (!title) continue;
      const inserted = await db.query(
        `INSERT INTO todos (created_by, title, notes, due_date, priority, assignee_id, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $1, NOW()) RETURNING id`,
        [req.user.id, title, sanitizeText(item.notes, 5000) || '', parseDate(item.due_date), parsePriority(item.priority)]
      );
      await db.query(
        'INSERT INTO todo_members (todo_id, user_id, list_id, added_by) VALUES ($1, $2, $3, $2)',
        [inserted.rows[0].id, req.user.id, listId]
      );
      created += 1;
    }
    announceTo([req.user.id], 0, 'imported');
    res.status(201).json({ created });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/share — { conversation_ids: [], todo_ids: [], title?, note? }
router.post('/share', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const conversationIds = [...new Set((req.body.conversation_ids || []).map(Number).filter(Boolean))].slice(0, 20);
    const todoIds = [...new Set((req.body.todo_ids || []).map(Number).filter(Boolean))].slice(0, 100);
    if (!conversationIds.length || !todoIds.length) {
      return res.status(400).json({ error: 'Pick at least one chat and one to-do' });
    }

    const todos = await listTodos(actor.id, {
      actor,
      where: 't.id = ANY($5::int[])',
      params: [todoIds],
      tail: 'ORDER BY t.is_done, t.due_date NULLS LAST, t.priority',
    });
    if (!todos.length) return res.status(404).json({ error: 'To-dos not found' });

    const allowed = await db.query(
      `SELECT conversation_id FROM conversation_participants
       WHERE user_id = $1 AND conversation_id = ANY($2::int[])`,
      [actor.id, conversationIds]
    );
    if (!allowed.rows.length) return res.status(403).json({ error: 'You are not in those chats' });

    const meta = {
      kind: 'todos',
      title: sanitizeText(req.body.title, 120) || null,
      owner: { id: actor.id, name: actor.name },
      items: todos.map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes || '',
        due_date: t.due_date,
        due_time: t.due_time,
        priority: t.priority,
        is_done: t.is_done,
        status: t.status,
        business_name: t.business_name || null,
        assignee_name: t.assignee_name || null,
      })),
    };
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

// GET /api/todos/:id — one to-do I can see (used by deep links to items outside the loaded window)
router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const todo = await visibleTodo(req, res, actor);
    if (!todo) return;
    const children = await listTodos(actor.id, { actor, where: 't.parent_id = $5', params: [todo.id], tail: 'ORDER BY t.id' });
    res.json({ todo, subtasks: children });
  } catch (err) {
    next(err);
  }
});

// PUT /api/todos/:id — edit; list_id / section_id only move it in *my* lists (personal to-dos)
router.put('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (!existing.permissions.can_edit) {
      return res.status(403).json({ error: 'Only the person who set this, or someone senior to them, can edit it' });
    }

    const title = req.body.title !== undefined ? sanitizeText(req.body.title, 500) : existing.title;
    if (!title) return res.status(400).json({ error: 'Title cannot be empty' });
    const notes = req.body.notes !== undefined ? sanitizeText(req.body.notes, 5000) : existing.notes;
    const dueDate = req.body.due_date !== undefined ? parseDate(req.body.due_date) : existing.due_date;
    const dueTime = req.body.due_time !== undefined ? parseTime(req.body.due_time) : existing.due_time;
    const priority = req.body.priority !== undefined ? parsePriority(req.body.priority, existing.priority) : existing.priority;
    const recurrence = req.body.recurrence !== undefined
      ? (RECURRENCES.includes(req.body.recurrence) ? req.body.recurrence : null)
      : existing.recurrence;
    const labels = req.body.labels !== undefined ? parseLabels(req.body.labels) : existing.labels;
    const deadline = req.body.deadline_date !== undefined ? parseDate(req.body.deadline_date) : existing.deadline_date;
    const duration = req.body.duration_minutes !== undefined ? parseDuration(req.body.duration_minutes) : existing.duration_minutes;
    const offsets = dueTime
      ? (req.body.reminder_offsets !== undefined ? parseOffsets(req.body.reminder_offsets) : existing.reminder_offsets)
      : [];
    const requiresApproval = existing.business_id && !existing.parent_id && req.body.requires_approval !== undefined
      ? !!req.body.requires_approval
      : existing.requires_approval;
    const scheduleChanged = dueDate !== existing.due_date || dueTime !== existing.due_time;
    const offsetsChanged = JSON.stringify(offsets) !== JSON.stringify(existing.reminder_offsets);

    // Validate placement / nesting / assignment before touching anything.
    const touchesPlacement = !existing.business_id && (req.body.list_id !== undefined || req.body.section_id !== undefined);
    let place = null;
    if (touchesPlacement) {
      const listId = req.body.list_id !== undefined ? (parseInt(req.body.list_id, 10) || null) : existing.list_id;
      const sectionId = req.body.section_id !== undefined
        ? (parseInt(req.body.section_id, 10) || null)
        : (listId === existing.list_id ? existing.section_id : null);
      place = await resolvePlacement(actor.id, listId, sectionId);
      if (place.error) return res.status(404).json({ error: place.error });
    }

    let newParent;
    if (req.body.parent_id !== undefined) {
      newParent = parseInt(req.body.parent_id, 10) || null;
      if (newParent) {
        if (newParent === existing.id) return res.status(400).json({ error: 'A to-do cannot be its own sub-task' });
        const parent = await getTodoFor(newParent, actor.id, actor);
        if (!parent) return res.status(404).json({ error: 'To-do not found' });
        if (!parent.permissions.can_add_subtask) return res.status(403).json({ error: 'You cannot add to that to-do' });
        if ((parent.business_id || null) !== (existing.business_id || null)) {
          return res.status(400).json({ error: 'A to-do cannot move between personal and business' });
        }
        if ((await descendantIds(existing.id)).includes(parent.id)) {
          return res.status(400).json({ error: 'A to-do cannot go inside its own sub-tasks' });
        }
        if ((await depthOf(parent.id)) + 1 + (await heightOf(existing.id)) > MAX_DEPTH) {
          return res.status(400).json({ error: `Sub-tasks can go ${MAX_DEPTH} levels deep` });
        }
        if (!existing.business_id) place = { listId: parent.list_id, sectionId: parent.section_id };
      }
    }

    let newAssignee = null;
    if (req.body.assigned_user_id !== undefined && existing.business_id) {
      newAssignee = parseInt(req.body.assigned_user_id, 10) || null;
      if (newAssignee !== existing.assignee_id) {
        if (!existing.permissions.can_assign) return res.status(403).json({ error: 'You cannot give this to someone else' });
        if (newAssignee && !(await isAssignable(newAssignee, existing.business_id))) {
          return res.status(400).json({ error: 'That person is not part of this business' });
        }
      }
    }

    await db.query(
      `UPDATE todos SET title = $1, notes = $2, due_date = $3, due_time = $4, priority = $5, recurrence = $6,
         labels = $7, deadline_date = $8, duration_minutes = $9, reminder_offsets = $10, requires_approval = $14,
         reminded_at = CASE WHEN $11::boolean THEN NULL ELSE reminded_at END,
         last_overdue_notification_at = CASE WHEN $11::boolean THEN NULL ELSE last_overdue_notification_at END,
         reminders_sent = CASE WHEN $11::boolean OR $12::boolean THEN '{}'::int[] ELSE reminders_sent END
       WHERE id = $13`,
      [title, notes || '', dueDate, dueTime, priority, recurrence, labels, deadline, duration, offsets,
        scheduleChanged, offsetsChanged, existing.id, requiresApproval]
    );
    if (newParent !== undefined) {
      await db.query('UPDATE todos SET parent_id = $1 WHERE id = $2', [newParent, existing.id]);
    }

    // Timeline: schedule and priority changes are what a manager asks about ("why was this moved?").
    const when = (d, t) => (d ? `${d}${t ? ` ${t}` : ''}` : null);
    const evt = { todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id };
    if (scheduleChanged) {
      await logEvent({ ...evt, kind: 'due_changed', from: when(existing.due_date, existing.due_time), to: when(dueDate, dueTime) });
    }
    if (deadline !== existing.deadline_date) {
      await logEvent({ ...evt, kind: 'deadline_changed', from: existing.deadline_date, to: deadline });
    }
    if (priority !== existing.priority) {
      await logEvent({ ...evt, kind: 'priority_changed', from: `P${existing.priority}`, to: `P${priority}` });
    }
    if (title !== existing.title || (notes || '') !== (existing.notes || '')) {
      await logEvent({ ...evt, kind: 'edited', note: title !== existing.title ? 'Title changed' : 'Description changed' });
    }

    if (place) {
      await db.query(
        'UPDATE todo_members SET list_id = $1, section_id = $2 WHERE todo_id = $3 AND user_id = $4',
        [place.listId, place.sectionId, existing.id, actor.id]
      );
      // Sub-tasks, however deep, stay with their parent in my lists.
      await db.query(
        'UPDATE todo_members SET list_id = $1, section_id = $2 WHERE user_id = $3 AND todo_id = ANY($4::int[])',
        [place.listId, place.sectionId, actor.id, await descendantIds(existing.id)]
      );
    }

    if (existing.business_id && req.body.assigned_user_id !== undefined && newAssignee !== existing.assignee_id) {
      if (newAssignee) await assignTodo({ id: existing.id, title }, newAssignee, actor);
      else {
        await db.query('UPDATE todos SET assignee_id = NULL, assigned_at = NULL, started_at = NULL WHERE id = $1', [existing.id]);
        await logEvent({ ...evt, kind: 'assigned', from: existing.assignee_name, to: null, note: 'Open to the business' });
      }
    }

    await addMentionedMembers({ id: existing.id, title }, `${title} ${notes || ''}`, req.body.mention_ids, actor);

    await announce(existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

/**
 * Mark a to-do finished (or, when it repeats, roll it to its next date and start every clock again).
 * Everything below it is finished too. Returns the next due date for a repeating to-do, else null.
 */
async function finishTodo(existing, actor, { doneBy = actor.id } = {}) {
  const evt = { todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id };
  const below = await descendantIds(existing.id);
  const snapshot = completionSnapshot(existing);

  if (existing.recurrence) {
    const rolledTo = nextOccurrence(existing.due_date || todayInAppZone(), existing.recurrence, todayInAppZone());
    await db.query(
      `UPDATE todos SET due_date = $1, reminded_at = NULL, reminders_sent = '{}', done_at = NOW(), done_by = $2,
         submitted_by = NULL, submitted_at = NULL, approved_by = NULL, approved_at = NULL
       WHERE id = $3`,
      [rolledTo, doneBy, existing.id]
    );
    await resolveOpenBlockers(existing.id, actor.id, 'Completed');
    // A new round starts: sub-tasks are unticked again and every clock restarts.
    await db.query(
      `UPDATE todos SET status = 'todo', status_since = NOW(), status_seconds = '{}'::jsonb, started_at = NULL, assigned_at = NOW()
       WHERE id = $1`,
      [existing.id]
    );
    await db.query(
      `UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL, status = 'todo', status_since = NOW(),
              status_seconds = '{}'::jsonb, started_at = NULL
       WHERE id = ANY($1::int[])`,
      [below]
    );
    await logEvent({ ...evt, kind: 'completed', meta: { ...snapshot, recurring: true, next_due: rolledTo } });
    return rolledTo;
  }

  await db.query('UPDATE todos SET is_done = TRUE, done_at = NOW(), done_by = $1 WHERE id = $2', [doneBy, existing.id]);
  await setStatus(existing.id, 'done');
  await resolveOpenBlockers(existing.id, actor.id, 'Completed');
  await db.query(
    `UPDATE todos SET is_done = TRUE, done_at = NOW(), done_by = $1, status = 'done', status_since = NOW()
     WHERE id = ANY($2::int[]) AND is_done = FALSE`,
    [doneBy, below]
  );
  await clearWarnings(existing.id);
  await logEvent({ ...evt, kind: 'completed', meta: snapshot });
  await releaseDependents(existing.id, actor);
  return null;
}

/** Reopen a finished to-do; a finished parent (at any level above) is reopened with it. */
async function reopenTodo(existing, actor) {
  const target = existing.started_at ? 'in_progress' : 'todo';
  await db.query(
    `UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL, approved_by = NULL, approved_at = NULL,
            submitted_by = NULL, submitted_at = NULL WHERE id = $1`,
    [existing.id]
  );
  await setStatus(existing.id, target);
  await logEvent({ todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'reopened', to: target });

  let parentId = existing.parent_id;
  while (parentId) {
    const parent = (await db.query(
      'SELECT id, parent_id, assignee_id, started_at, is_done FROM todos WHERE id = $1', [parentId]
    )).rows[0];
    if (!parent || !parent.is_done) break;
    await db.query(
      'UPDATE todos SET is_done = FALSE, done_at = NULL, done_by = NULL, approved_by = NULL, approved_at = NULL WHERE id = $1',
      [parent.id]
    );
    const parentTarget = parent.started_at ? 'in_progress' : 'todo';
    await setStatus(parent.id, parentTarget);
    await logEvent({
      todoId: parent.id, userId: actor.id, subjectId: parent.assignee_id, kind: 'reopened', to: parentTarget,
      note: 'A sub-task was reopened',
    });
    parentId = parent.parent_id;
  }
}

/** Hand finished work to a reviewer instead of closing it. */
async function submitForReview(existing, actor) {
  await db.query(
    `UPDATE todos SET submitted_by = $1, submitted_at = NOW(), approved_by = NULL, approved_at = NULL WHERE id = $2`,
    [actor.id, existing.id]
  );
  await resolveOpenBlockers(existing.id, actor.id, 'Sent for review');
  const moved = await setStatus(existing.id, 'in_review');
  await logEvent({
    todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'submitted',
    from: moved.from, to: 'in_review',
  });
  await notify(await reviewersFor(existing, actor), {
    type: 'approval_request',
    title: `${actor.name} finished a task and needs your review`,
    body: existing.title,
    data: { todoId: existing.id },
  }, { exclude: [actor.id] });
}

// POST /api/todos/:id/toggle — tick / untick. Recurring to-dos roll forward; business work that needs
// review goes "in review" instead of closing. Ticking a parent ticks everything below it; reopening a
// sub-task reopens its finished parents.
router.post('/:id(\\d+)/toggle', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (!existing.permissions.can_change_status) {
      return res.status(403).json({ error: 'You cannot update this one' });
    }
    if (existing.review_state !== 'accepted') {
      return res.status(400).json({ error: 'This is still waiting for review' });
    }

    let rolledTo = null;
    if (existing.is_done) {
      await reopenTodo(existing, actor);
    } else if (existing.status === 'in_review') {
      // Pull finished work back out of review (the person who sent it, or the reviewer).
      if (existing.submitted_by !== actor.id && !existing.permissions.can_approve) {
        return res.status(403).json({ error: 'Only the person who sent it, or a reviewer, can take it back' });
      }
      const target = existing.started_at ? 'in_progress' : 'todo';
      await db.query('UPDATE todos SET submitted_by = NULL, submitted_at = NULL WHERE id = $1', [existing.id]);
      await setStatus(existing.id, target);
      await logEvent({
        todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'reopened', to: target,
        note: 'Taken back from review',
      });
    } else if (existing.business_id && existing.requires_approval && !existing.permissions.can_edit) {
      await submitForReview(existing, actor);
    } else {
      rolledTo = await finishTodo(existing, actor);
      if (existing.business_id) await ensureMember(existing.id, actor.id, actor.id);
    }

    const finished = !existing.is_done && existing.status !== 'in_review';
    if (finished && !(existing.business_id && existing.requires_approval && !existing.permissions.can_edit)) {
      const people = [...new Set([...(await memberIds(existing.id)), existing.created_by, existing.assignee_id].filter(Boolean))];
      if (existing.business_id) {
        await notify(people, {
          type: 'task_completed',
          title: `${actor.name} completed a task`,
          body: existing.title,
          data: { todoId: existing.id },
        }, { exclude: [actor.id] });
      } else if (people.length > 1) {
        await notify(people, {
          type: 'todo_done',
          title: `${actor.name} ticked off a shared to-do`,
          body: existing.title,
          data: { todoId: existing.id },
        }, { exclude: [actor.id] });
      }
    }

    await announce(existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor), rolled_to: rolledTo });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/approve — { note? } accept business work that is in review
router.post('/:id(\\d+)/approve', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (!existing.permissions.can_approve) return res.status(403).json({ error: 'You cannot approve this' });

    const note = sanitizeText(req.body.note, 1000);
    const worker = existing.submitted_by || existing.assignee_id || actor.id;
    const rolledTo = await finishTodo(existing, actor, { doneBy: worker });
    if (!rolledTo) {
      await db.query('UPDATE todos SET approved_by = $1, approved_at = NOW() WHERE id = $2', [actor.id, existing.id]);
    }
    await logEvent({
      todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'approved', note: note || null,
    });
    await notify([existing.submitted_by, existing.assignee_id, existing.created_by], {
      type: 'task_approved',
      title: `${actor.name} approved the work`,
      body: existing.title,
      data: { todoId: existing.id },
    }, { exclude: [actor.id] });

    await announce(existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor), rolled_to: rolledTo });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/reject — { note? } send business work in review back for changes
router.post('/:id(\\d+)/reject', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (!existing.permissions.can_approve) return res.status(403).json({ error: 'You cannot review this' });

    const note = sanitizeText(req.body.note, 1000);
    await db.query('UPDATE todos SET submitted_by = NULL, submitted_at = NULL WHERE id = $1', [existing.id]);
    await setStatus(existing.id, 'in_progress');
    await logEvent({
      todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'changes_requested',
      from: 'in_review', to: 'in_progress', note: note || null,
    });
    await notify([existing.submitted_by, existing.assignee_id], {
      type: 'task_rejected',
      title: `${actor.name} asked for changes`,
      body: note ? `${existing.title}: ${note}` : existing.title,
      data: { todoId: existing.id },
    }, { exclude: [actor.id] });

    await announce(existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/review — { decision: 'accept' | 'reject', note? } decide on a proposed business to-do
router.post('/:id(\\d+)/review', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (!existing.permissions.can_review) return res.status(403).json({ error: 'You cannot decide on this' });
    const decision = req.body.decision;
    if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose accept or reject' });
    const note = sanitizeText(req.body.note, 1000) || null;
    const state = decision === 'accept' ? 'accepted' : 'rejected';

    // The decision covers everything below it as well.
    const ids = [existing.id, ...(await descendantIds(existing.id))];
    await db.query(
      `UPDATE todos SET review_state = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3
       WHERE id = ANY($4::int[])`,
      [state, actor.id, note, ids]
    );
    await logEvent({
      todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id,
      kind: decision === 'accept' ? 'proposal_accepted' : 'proposal_rejected', note,
    });
    await notify([existing.created_by, existing.assignee_id], {
      type: 'todo_review',
      title: decision === 'accept' ? `${actor.name} accepted your task` : `${actor.name} declined your task`,
      body: note ? `${existing.title}: ${note}` : existing.title,
      data: { todoId: existing.id },
    }, { exclude: [actor.id] });
    if (decision === 'accept' && !existing.assignee_id) {
      await notify(await businessMemberIds(existing.business_id, { excludeId: actor.id }), {
        type: 'todo_added',
        title: `New task for ${existing.business_name}`,
        body: existing.title,
        data: { todoId: existing.id },
      }, { exclude: [existing.created_by] });
    }

    await announce(existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/warn — { message } warn the person doing it (must be senior to them)
router.post('/:id(\\d+)/warn', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    const message = sanitizeText(req.body.message, 1000);
    if (!message) return res.status(400).json({ error: 'Warning message is required' });
    if (existing.is_done) return res.status(400).json({ error: 'Cannot warn on a finished task' });
    if (existing.status === 'on_hold') return res.status(400).json({ error: 'Cannot warn on a task that is on hold' });
    if (!existing.permissions.can_warn) {
      return res.status(403).json({ error: 'Only someone senior to the assignee can send a warning' });
    }

    // Unassigned: warn everyone in the business who is junior to the sender.
    const targets = (existing.assignee_id
      ? [existing.assignee_id]
      : await businessMemberIds(existing.business_id, { belowLevel: actorLevelIn(actor, existing.business_id) })
    ).filter((id) => id !== actor.id);
    if (!targets.length) return res.status(400).json({ error: 'No one to warn for this task' });

    await db.query('UPDATE todos SET is_warned = TRUE WHERE id = $1', [existing.id]);
    for (const uid of targets) {
      await db.query('INSERT INTO warnings (todo_id, user_id, sent_by, message) VALUES ($1, $2, $3, $4)', [existing.id, uid, actor.id, message]);
      await db.query("UPDATE users SET status = 'warned' WHERE id = $1 AND status = 'active'", [uid]);
    }
    await logEvent({ todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'warning', note: message });
    await notify(targets, {
      type: 'warning',
      title: `Warning from ${actor.name}`,
      body: `${existing.title}: ${message}`,
      data: { todoId: existing.id },
    });

    await announce(existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/request-delete — { reason } asks someone senior to delete a business to-do
router.post('/:id(\\d+)/request-delete', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (!existing.business_id) return res.status(400).json({ error: 'You can delete your own to-dos directly' });
    if (existing.permissions.can_delete) return res.status(400).json({ error: 'You can delete this directly' });
    if (existing.pending_delete_request_id) return res.status(409).json({ error: 'A deletion request is already pending' });

    const reason = sanitizeText(req.body.reason, 1000);
    const myLevel = actorLevelIn(actor, existing.business_id);
    const inserted = await db.query(
      `INSERT INTO approvals (kind, todo_id, business_id, requested_by, requester_level, reason, subject)
       VALUES ('todo_deletion', $1, $2, $3, $4, $5, $6) RETURNING *`,
      [existing.id, existing.business_id, actor.id, myLevel, reason || null, existing.title]
    );
    await logEvent({ todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'delete_requested', note: reason || null });

    const approvers = new Set(await nextApprovers(existing.business_id, myLevel, actor.id));
    approvers.add(existing.created_by);
    await notify([...approvers], {
      type: 'approval_request',
      title: `${actor.name} asked to delete a task`,
      body: reason ? `${existing.title} — "${reason}"` : existing.title,
      data: { todoId: existing.id, approvalId: inserted.rows[0].id },
    }, { exclude: [actor.id] });

    await announce(existing.id);
    res.status(201).json({ approval: inserted.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/move-to-business — { business_id, assign_to? }
// Turns my own personal to-do (with everything below it) into a task of a business. A manager's task is
// accepted straight away; anyone else's becomes a proposal the managers review.
router.post('/:id(\\d+)/move-to-business', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (existing.business_id) return res.status(400).json({ error: 'This is already a business task' });
    if (existing.parent_id) return res.status(400).json({ error: 'Move the main to-do; its sub-tasks go with it' });
    if (existing.created_by !== actor.id) return res.status(403).json({ error: 'Only the person who created this can move it' });

    const businessId = parseInt(req.body.business_id, 10) || null;
    const business = businessId
      ? (await db.query('SELECT id, name FROM businesses WHERE id = $1', [businessId])).rows[0]
      : null;
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!isLeader(actor) && !actor.memberships.has(businessId)) {
      return res.status(403).json({ error: 'You are not part of this business' });
    }

    const assignTo = parseInt(req.body.assign_to, 10) || null;
    if (assignTo && !(await isAssignable(assignTo, businessId))) {
      return res.status(400).json({ error: 'That person is not part of this business' });
    }
    const manages = isLeader(actor) || managesBusiness(actor, businessId);
    const reviewState = manages ? 'accepted' : 'proposed';
    const assigneeId = reviewState === 'proposed' ? actor.id : (assignTo || actor.id);
    const sourceBusinessId = !actor.memberships.has(businessId) && !isLeader(actor)
      ? ([...actor.memberships.keys()][0] || null)
      : null;

    const below = await descendantIds(existing.id);
    const all = [existing.id, ...below];
    await db.query(
      `UPDATE todos SET business_id = $1, review_state = $2, requires_approval = FALSE, source_business_id = $3
       WHERE id = ANY($4::int[])`,
      [businessId, reviewState, sourceBusinessId, all]
    );
    await db.query(
      `UPDATE todos SET assignee_id = $1::int, assigned_at = COALESCE(assigned_at, NOW()) WHERE id = $2`,
      [assigneeId, existing.id]
    );
    // A business task is seen through the business, not through anybody's own lists.
    await db.query('UPDATE todo_members SET list_id = NULL, section_id = NULL WHERE todo_id = ANY($1::int[])', [all]);
    await ensureMember(existing.id, assigneeId, actor.id, { withDescendants: true });

    await logEvent({
      todoId: existing.id, userId: actor.id, subjectId: assigneeId, kind: 'moved',
      note: `Moved to ${business.name}`, meta: { business_id: businessId, review_state: reviewState },
    });

    if (reviewState === 'proposed') {
      const approvers = await nextApprovers(businessId, actorLevelIn(actor, businessId), actor.id);
      await notify(approvers, {
        type: 'todo_proposed',
        title: `${actor.name} proposed a task`,
        body: `${existing.title} · ${business.name}`,
        data: { todoId: existing.id },
      });
    } else if (assigneeId !== actor.id) {
      await notify([assigneeId], {
        type: 'todo_assigned',
        title: `${actor.name} assigned you a task`,
        body: `${existing.title} · ${business.name}`,
        data: { todoId: existing.id },
      });
    }

    // Everyone who could see it before and everyone in the business hears about it.
    await announce(existing.id, 'updated');
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/duplicate — copy (with everything below it) into my own list
router.post('/:id(\\d+)/duplicate', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const src = await visibleTodo(req, res, actor);
    if (!src) return;
    if (src.business_id) return res.status(400).json({ error: 'Business tasks cannot be duplicated; create a new one instead' });

    const copy = async (row, parentId) => {
      const inserted = await db.query(
        `INSERT INTO todos (created_by, title, notes, due_date, due_time, priority, recurrence,
                            parent_id, labels, deadline_date, duration_minutes, reminder_offsets,
                            assignee_id, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $1, NOW()) RETURNING id`,
        [actor.id, row.title, row.notes || '', row.due_date, row.due_time, row.priority, row.recurrence,
          parentId, row.labels || [], row.deadline_date, row.duration_minutes, row.reminder_offsets || []]
      );
      const id = inserted.rows[0].id;
      await db.query(
        'INSERT INTO todo_members (todo_id, user_id, list_id, section_id, added_by) VALUES ($1, $2, $3, $4, $2)',
        [id, actor.id, src.list_id, src.section_id]
      );
      return id;
    };
    const copyTree = async (row, parentId) => {
      const id = await copy(row, parentId);
      const children = await listTodos(actor.id, { actor, where: 't.parent_id = $5', params: [row.id], tail: 'ORDER BY t.id' });
      for (const child of children) await copyTree(child, id);
      return id;
    };

    const newId = await copyTree(src, src.parent_id);
    announceTo([actor.id], newId, 'created');
    res.status(201).json({ todo: await getTodoFor(newId, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/:id — personal: the creator deletes for everyone, others just leave it.
// Business: whoever set it or is senior to them deletes; everyone else asks (see request-delete).
router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    const audience = await audienceIds(existing.id);
    const evtMeta = {
      title: existing.title, status: existing.status, was_done: existing.is_done,
      created_at: existing.created_at, due_date: existing.due_date, business_id: existing.business_id,
    };

    if (existing.business_id) {
      if (!existing.permissions.can_delete) {
        return res.status(403).json({
          error: 'Only the person who set this, or someone senior, can delete it. You can ask for it to be deleted instead.',
          can_request: existing.permissions.can_request_delete,
        });
      }
      // The log outlives the to-do: deleting does not erase the record of it.
      await logEvent({ todoId: null, userId: actor.id, subjectId: existing.assignee_id, kind: 'deleted', meta: evtMeta });
      await clearWarnings(existing.id);
      await db.query('DELETE FROM todos WHERE id = $1', [existing.id]);
      await notify([existing.assignee_id, existing.created_by], {
        type: 'task_deleted',
        title: `${actor.name} deleted a task`,
        body: existing.title,
        data: {},
      }, { exclude: [actor.id] });
      announceTo(audience, existing.id, 'deleted');
      return res.json({ deleted: true });
    }

    if (existing.created_by === actor.id) {
      await logEvent({ todoId: null, userId: actor.id, subjectId: existing.assignee_id, kind: 'deleted', meta: evtMeta });
      await db.query('DELETE FROM todos WHERE id = $1', [existing.id]);
      announceTo(audience, existing.id, 'deleted');
      return res.json({ deleted: true });
    }
    await logEvent({
      todoId: existing.id, userId: actor.id, subjectId: existing.assignee_id, kind: 'left',
      meta: { title: existing.title },
    });
    await db.query(
      'DELETE FROM todo_members WHERE user_id = $2 AND todo_id = ANY($1::int[])',
      [[existing.id, ...(await descendantIds(existing.id))], actor.id]
    );
    // Someone who walks away from a to-do cannot stay accountable for it: it goes back to its creator.
    if (existing.assignee_id === actor.id) {
      await assignTodo({ id: existing.id, title: existing.title }, existing.created_by, actor);
    }
    announceTo(audience, existing.id);
    res.json({ left: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/:id/members/:userId — creator removes someone from a shared personal to-do
router.delete('/:id(\\d+)/members/:userId', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    if (existing.business_id) return res.status(400).json({ error: 'People on a business task follow the business' });
    const targetId = parseInt(req.params.userId, 10);
    if (existing.created_by !== actor.id && targetId !== actor.id) {
      return res.status(403).json({ error: 'Only the creator can remove people' });
    }
    if (targetId === existing.created_by) return res.status(400).json({ error: 'The creator cannot be removed' });
    const audience = await audienceIds(existing.id);
    await db.query(
      'DELETE FROM todo_members WHERE user_id = $2 AND todo_id = ANY($1::int[])',
      [[existing.id, ...(await descendantIds(existing.id))], targetId]
    );
    if (existing.assignee_id === targetId) {
      await assignTodo({ id: existing.id, title: existing.title }, existing.created_by, actor);
    }
    announceTo(audience, existing.id);
    res.json({ todo: await getTodoFor(existing.id, actor.id, actor) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Comments (a conversation about the work; the description lives in `notes`)
// ---------------------------------------------------------------------------
// $2 is the viewer: "mine" on a reaction says whether they have used it.
const COMMENT_SELECT = `
  SELECT c.id, c.todo_id, c.user_id, c.body, c.kind, c.parent_id, c.created_at,
         u.name AS user_name, u.username AS user_username, u.profile_picture AS user_picture,
         COALESCE((SELECT json_agg(json_build_object('kind', r.kind, 'count', r.n, 'mine', r.mine) ORDER BY r.first)
                   FROM (SELECT kind, COUNT(*)::int AS n, BOOL_OR(user_id = $2) AS mine, MIN(created_at) AS first
                         FROM todo_comment_reactions WHERE comment_id = c.id GROUP BY kind) r), '[]'::json) AS reactions,
         COALESCE((SELECT json_agg(json_build_object('id', a.id, 'url', a.url, 'filename', a.filename, 'mime', a.mime, 'size', a.size_bytes) ORDER BY a.id)
                   FROM todo_attachments a WHERE a.comment_id = c.id), '[]'::json) AS attachments
  FROM todo_comments c LEFT JOIN users u ON u.id = c.user_id`;

router.get('/:id(\\d+)/comments', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    const result = await db.query(`${COMMENT_SELECT} WHERE c.todo_id = $1 ORDER BY c.created_at, c.id`, [existing.id, actor.id]);
    res.json({ comments: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/:id/comments — { body, mention_ids?, parent_id?, attachment_ids? }
// A reply names the comment it answers; replying to a reply joins the same thread.
router.post('/:id(\\d+)/comments', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = await visibleTodo(req, res, actor);
    if (!existing) return;
    const body = sanitizeText(req.body.body, 3000) || '';
    const attachmentIds = (Array.isArray(req.body.attachment_ids) ? req.body.attachment_ids : []).map(Number).filter(Number.isInteger).slice(0, 10);
    if (!body && !attachmentIds.length) return res.status(400).json({ error: 'Write a comment first' });

    let parent = null;
    if (req.body.parent_id) {
      const p = await db.query('SELECT id, user_id, parent_id FROM todo_comments WHERE id = $1 AND todo_id = $2', [Number(req.body.parent_id), existing.id]);
      if (!p.rows.length) return res.status(400).json({ error: 'The comment you are replying to is gone' });
      parent = { id: p.rows[0].parent_id || p.rows[0].id, author: p.rows[0].user_id };
    }

    const inserted = await db.query(
      'INSERT INTO todo_comments (todo_id, user_id, body, parent_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [existing.id, actor.id, body, parent?.id || null]
    );
    if (attachmentIds.length) {
      await db.query(
        'UPDATE todo_attachments SET comment_id = $1, draft = FALSE WHERE id = ANY($2::int[]) AND todo_id = $3 AND user_id = $4 AND comment_id IS NULL',
        [inserted.rows[0].id, attachmentIds, existing.id, actor.id]
      );
    }
    const mentioned = await addMentionedMembers({ id: existing.id, title: existing.title }, body, req.body.mention_ids, actor);
    // Everyone named with @ hears about it, even if they were already on the to-do.
    const named = (await resolveMentions(body, req.body.mention_ids)).map((m) => m.id).filter((id) => id !== actor.id);
    const stillToTell = named.filter((id) => !mentioned.includes(id));
    if (stillToTell.length) {
      await notify(stillToTell, {
        type: 'todo_mention',
        title: `${actor.name} mentioned you`,
        body: `${existing.title}: ${body.slice(0, 120)}`,
        data: { todoId: existing.id },
      });
    }
    // The person being replied to is told too, unless a mention already did.
    const replyTo = parent && parent.author && parent.author !== actor.id && !named.includes(parent.author) ? parent.author : null;
    if (replyTo) {
      await notify([replyTo], {
        type: 'todo_reply',
        title: `${actor.name} replied to you`,
        body: `${existing.title}: ${body.slice(0, 120)}`,
        data: { todoId: existing.id },
      });
    }

    const members = await memberIds(existing.id);
    // People who asked a question (e.g. a manager monitoring) hear about the answer too.
    const askers = (await db.query(
      `SELECT DISTINCT user_id FROM todo_comments WHERE todo_id = $1 AND kind = 'question' AND user_id IS NOT NULL`,
      [existing.id]
    )).rows.map((r) => r.user_id);
    await notify([...members, ...askers, existing.created_by, existing.assignee_id].filter(Boolean), {
      type: 'todo_comment',
      title: `${actor.name} commented`,
      body: `${existing.title}: ${body.slice(0, 120)}`,
      data: { todoId: existing.id },
    }, { exclude: [actor.id, ...mentioned, ...named, ...(replyTo ? [replyTo] : [])] });
    await announce(existing.id, 'commented');

    const comment = await db.query(`${COMMENT_SELECT} WHERE c.id = $1`, [inserted.rows[0].id, actor.id]);
    res.status(201).json({ comment: comment.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/comments/:commentId — the author, whoever may edit the to-do, or its creator
router.delete('/comments/:commentId(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const found = await db.query('SELECT id, user_id, todo_id FROM todo_comments WHERE id = $1', [req.params.commentId]);
    const row = found.rows[0];
    const todo = row ? await getTodoFor(row.todo_id, actor.id, actor) : null;
    if (!row || !todo) return res.status(404).json({ error: 'Comment not found' });
    if (row.user_id !== actor.id && todo.created_by !== actor.id && !todo.permissions.can_edit) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    await db.query('DELETE FROM todo_comments WHERE id = $1', [row.id]);
    await announce(row.todo_id, 'commented');
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
router.post('/lists', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const color = LIST_COLORS.includes(req.body.color) ? req.body.color : 'indigo';
    const emoji = sanitizeText(req.body.emoji, 16) || null;
    const order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_lists WHERE owner_id = $1', [req.user.id]);
    const result = await db.query(
      `INSERT INTO todo_lists (owner_id, name, color, emoji, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, name, color, emoji, order.rows[0].next]
    );
    res.status(201).json({ list: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/lists/:id', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'List name is required' });
    const color = LIST_COLORS.includes(req.body.color) ? req.body.color : 'indigo';
    const emoji = sanitizeText(req.body.emoji, 16) || null;
    const result = await db.query(
      `UPDATE todo_lists SET name = $1, color = $2, emoji = $3 WHERE id = $4 AND owner_id = $5 RETURNING *`,
      [name, color, emoji, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'List not found' });
    res.json({ list: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/lists/:id — its to-dos move back to the Inbox
router.delete('/lists/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM todo_lists WHERE id = $1 AND owner_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'List not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sections (inside one of my lists)
// ---------------------------------------------------------------------------
router.post('/lists/:id/sections', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Section name is required' });
    if (!(await ownsList(parseInt(req.params.id, 10), req.user.id))) return res.status(404).json({ error: 'List not found' });
    const order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_sections WHERE list_id = $1', [req.params.id]);
    const result = await db.query(
      'INSERT INTO todo_sections (list_id, owner_id, name, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.id, req.user.id, name, order.rows[0].next]
    );
    res.status(201).json({ section: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/todos/sections — a section of the Inbox (no list)
router.post('/sections', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Section name is required' });
    const order = await db.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_sections WHERE owner_id = $1 AND list_id IS NULL',
      [req.user.id]
    );
    const result = await db.query(
      'INSERT INTO todo_sections (list_id, owner_id, name, sort_order) VALUES (NULL, $1, $2, $3) RETURNING *',
      [req.user.id, name, order.rows[0].next]
    );
    res.status(201).json({ section: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /api/todos/sections/order — { ids } the viewer's sections of one board (a list's, or the Inbox's) in
// their new left-to-right order. Ids that are not mine are ignored.
router.put('/sections/order', authenticate, async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map((v) => parseInt(v, 10)).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids are required' });
    await db.query(
      `UPDATE todo_sections s SET sort_order = o.ord::int
       FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord)
       WHERE s.id = o.id AND s.owner_id = $2`,
      [ids, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/sections/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Section name is required' });
    const result = await db.query(
      'UPDATE todo_sections SET name = $1 WHERE id = $2 AND owner_id = $3 RETURNING *',
      [name, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Section not found' });
    res.json({ section: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/todos/sections/:id — its to-dos stay in the list, without a section
router.delete('/sections/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      'DELETE FROM todo_sections WHERE id = $1 AND owner_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Section not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Saved filters
// ---------------------------------------------------------------------------
router.post('/filters', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Filter name is required' });
    const order = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM todo_filters WHERE owner_id = $1', [req.user.id]);
    const result = await db.query(
      'INSERT INTO todo_filters (owner_id, name, config, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, name, JSON.stringify(parseFilterConfig(req.body.config)), order.rows[0].next]
    );
    res.status(201).json({ filter: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/filters/:id', authenticate, async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Filter name is required' });
    const result = await db.query(
      'UPDATE todo_filters SET name = $1, config = $2 WHERE id = $3 AND owner_id = $4 RETURNING *',
      [name, JSON.stringify(parseFilterConfig(req.body.config)), req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Filter not found' });
    res.json({ filter: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/filters/:id', authenticate, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM todo_filters WHERE id = $1 AND owner_id = $2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Filter not found' });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.createTodoCore = createTodoCore;
module.exports.announce = announce;
