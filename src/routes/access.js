const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor, actorBestLevel, displayTitle } = require('../utils/org');
const { PERMISSIONS, isPermissionKey } = require('../utils/permissions');
const { listTodos } = require('../services/todoQueries');

const router = express.Router();

/** Only people with the manage_access switch get past this. */
async function requireManager(req, res, next) {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor || !actor.can('manage_access')) return res.status(403).json({ error: 'You cannot manage access' });
    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

/** Everyone I may change: strictly below me in the chain of command (the owner may change anyone). */
async function manageablePeople(actor) {
  const rows = (await db.query(
    `SELECT id FROM users WHERE status != 'inactive' AND id <> $1 ORDER BY name`,
    [actor.id]
  )).rows;
  const out = [];
  const myLevel = actorBestLevel(actor);
  for (const r of rows) {
    const target = await loadActor(r.id);
    if (!target) continue;
    const level = actorBestLevel(target);
    if (actor.global === 0 || myLevel < level) out.push({ target, level });
  }
  return out;
}

// GET /api/access/people — the switches for everyone I may manage
router.get('/people', authenticate, requireManager, async (req, res, next) => {
  try {
    const people = await manageablePeople(req.actor);
    const ids = people.map((p) => p.target.id);
    const watch = ids.length
      ? (await db.query('SELECT viewer_id, target_id FROM monitor_access WHERE viewer_id = ANY($1::int[])', [ids])).rows
      : [];
    const watchBy = new Map();
    for (const w of watch) {
      if (!watchBy.has(w.viewer_id)) watchBy.set(w.viewer_id, []);
      watchBy.get(w.viewer_id).push(w.target_id);
    }
    res.json({
      catalog: PERMISSIONS.map(({ key, label, description }) => ({
        key,
        label,
        description,
        // I can only hand out what I hold myself.
        grantable: req.actor.global === 0 || req.actor.can(key),
      })),
      people: people.map(({ target, level }) => ({
        id: target.id,
        name: target.name,
        username: target.username,
        level,
        title: displayTitle(target, null, null),
        permissions: Object.fromEntries(PERMISSIONS.map((p) => [p.key, {
          allowed: target.can(p.key),
          overridden: target.perms.has(p.key),
        }])),
        can_watch: watchBy.get(target.id) || [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/access/people/:id/permissions — { permission, allowed: true | false | null (back to the default) }
router.put('/people/:id/permissions', authenticate, requireManager, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const key = req.body.permission;
    if (!isPermissionKey(key)) return res.status(400).json({ error: 'Unknown permission' });
    const people = await manageablePeople(req.actor);
    if (!people.some((p) => p.target.id === targetId)) {
      return res.status(403).json({ error: 'You can only change people below you' });
    }
    if (req.actor.global !== 0 && !req.actor.can(key)) {
      return res.status(403).json({ error: 'You can only give access you have yourself' });
    }
    if (req.body.allowed === null) {
      await db.query('DELETE FROM user_permissions WHERE user_id = $1 AND permission = $2', [targetId, key]);
    } else {
      await db.query(
        `INSERT INTO user_permissions (user_id, permission, allowed, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, permission)
         DO UPDATE SET allowed = EXCLUDED.allowed, granted_by = EXCLUDED.granted_by, updated_at = NOW()`,
        [targetId, key, !!req.body.allowed, req.actor.id]
      );
    }
    const target = await loadActor(targetId);
    res.json({ ok: true, allowed: target.can(key), overridden: target.perms.has(key) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/access/people/:id/watch — { target_ids: [] } the extra people this person may watch in the Team monitor
router.put('/people/:id/watch', authenticate, requireManager, async (req, res, next) => {
  try {
    const viewerId = parseInt(req.params.id, 10);
    const people = await manageablePeople(req.actor);
    if (!people.some((p) => p.target.id === viewerId)) {
      return res.status(403).json({ error: 'You can only change people below you' });
    }
    const wanted = [...new Set((req.body.target_ids || []).map(Number).filter((n) => n && n !== viewerId))].slice(0, 200);
    const real = wanted.length
      ? (await db.query(`SELECT id FROM users WHERE id = ANY($1::int[]) AND status != 'inactive'`, [wanted])).rows.map((r) => r.id)
      : [];
    await db.query('DELETE FROM monitor_access WHERE viewer_id = $1', [viewerId]);
    if (real.length) {
      await db.query(
        `INSERT INTO monitor_access (viewer_id, target_id, granted_by)
         SELECT $1, t, $3 FROM unnest($2::int[]) AS t`,
        [viewerId, real, req.actor.id]
      );
    }
    res.json({ ok: true, can_watch: real });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------
// Everything view (view_all_todos): any person's to-dos, read-only. The default list never uses this.
// ---------------------------------------------------------------------------------------------
async function requireViewAll(req, res, next) {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor || !actor.can('view_all_todos')) return res.status(403).json({ error: "You cannot see everyone's to-dos" });
    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/access/everyone — each person with how many to-dos they are on
router.get('/everyone', authenticate, requireViewAll, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.username, u.profile_picture, u.org_level, u.role,
              COUNT(t.id) FILTER (WHERE t.is_done = FALSE AND t.parent_id IS NULL)::int AS open,
              COUNT(t.id) FILTER (WHERE t.is_done = TRUE AND t.parent_id IS NULL)::int AS done
       FROM users u
       LEFT JOIN todo_members m ON m.user_id = u.id
       LEFT JOIN todos t ON t.id = m.todo_id
       WHERE u.status != 'inactive'
       GROUP BY u.id
       ORDER BY u.org_level NULLS LAST, u.name`
    );
    res.json({ people: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/access/everyone/:userId/todos — everything this person is on, personal and business
router.get('/everyone/:userId(\\d+)/todos', authenticate, requireViewAll, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const todos = await listTodos(req.actor.id, {
      actor: req.actor,
      seeAll: true,
      where: `(EXISTS (SELECT 1 FROM todo_members x WHERE x.todo_id = t.id AND x.user_id = $5) OR t.assignee_id = $5)
              AND (t.is_done = FALSE OR t.done_at > NOW() - INTERVAL '30 days')`,
      params: [userId],
      tail: 'ORDER BY t.is_done, t.due_date ASC NULLS LAST, t.created_at DESC LIMIT 1500',
    });
    res.json({ todos });
  } catch (err) {
    next(err);
  }
});

async function requireChatAudit(req, res, next) {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor || !actor.can('chat_audit')) return res.status(403).json({ error: "You cannot read other people's chats" });
    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /api/access/chats — every conversation (chat_audit)
router.get('/chats', authenticate, requireChatAudit, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.type, c.name, c.business_id, c.updated_at,
              (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username,
                                                 'profile_picture', u.profile_picture) ORDER BY u.name)
               FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
               WHERE cp.conversation_id = c.id) AS participants,
              lm.body AS last_body, lm.created_at AS last_at, lm.meta AS last_meta, lu.name AS last_sender,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT m.body, m.created_at, m.meta, m.sender_id FROM messages m
         WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
       ) lm ON TRUE
       LEFT JOIN users lu ON lu.id = lm.sender_id
       ORDER BY COALESCE(lm.created_at, c.updated_at) DESC
       LIMIT 500`
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/access/chats/:id/messages?before= — read-only, including messages people deleted for themselves
router.get('/chats/:id(\\d+)/messages', authenticate, requireChatAudit, async (req, res, next) => {
  try {
    const before = parseInt(req.query.before, 10) || null;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const result = await db.query(
      `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name, m.body, m.attachment_url, m.attachment_type,
              m.created_at, m.is_edited, m.deleted_at, m.reply_to_id, m.meta
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 AND ($2::int IS NULL OR m.id < $2)
       ORDER BY m.id DESC LIMIT $3`,
      [req.params.id, before, limit]
    );
    res.json({ messages: result.rows.reverse(), has_more: result.rows.length === limit });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
