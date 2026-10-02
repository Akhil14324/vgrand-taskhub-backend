const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor, isLeader } = require('../utils/org');
const { todayInAppZone } = require('../utils/recurrence');
const { listTodos, getTodoFor } = require('../services/todoQueries');
const { sanitizeTree, fillTokens, treeFromRows, addDays } = require('../utils/templates');
// Required lazily: routes/todos.js is loaded first by server.js and exports the shared creator.
const todoRoutes = () => require('./todos');

const router = express.Router();

const SCOPES = ['personal', 'business', 'company'];

/** Templates this person may see: their own, their businesses', and the company's. */
const VISIBLE = `(
  t.owner_id = $1
  OR t.scope = 'company'
  OR (t.scope = 'business' AND t.business_id IN (SELECT business_id FROM user_businesses WHERE user_id = $1))
)`;

const SELECT = `
  SELECT t.id, t.name, t.description, t.scope, t.business_id, b.name AS business_name, t.item_count, t.uses,
         t.owner_id, u.name AS owner_name, t.updated_at`;

function canEdit(actor, row) {
  return row.owner_id === actor.id || (isLeader(actor) && row.scope !== 'personal');
}

/** Validates who may create a template of this scope; returns { scope, businessId } or { error }. */
async function resolveScope(actor, body) {
  const scope = SCOPES.includes(body.scope) ? body.scope : 'personal';
  if (scope === 'personal') return { scope, businessId: null };
  if (scope === 'company') {
    if (!isLeader(actor)) return { error: 'Only leadership can share a template with the whole company', status: 403 };
    return { scope, businessId: null };
  }
  const businessId = parseInt(body.business_id, 10) || null;
  if (!businessId) return { error: 'Choose a business', status: 400 };
  if (!isLeader(actor) && !actor.memberships.has(businessId)) return { error: 'You are not part of that business', status: 403 };
  return { scope, businessId };
}

// GET /api/templates
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    if (!actor) return res.status(401).json({ error: 'User no longer exists' });
    const rows = (await db.query(
      `${SELECT} FROM todo_templates t
       LEFT JOIN businesses b ON b.id = t.business_id
       LEFT JOIN users u ON u.id = t.owner_id
       WHERE ${VISIBLE} AND ($2::int IS NULL OR t.business_id = $2 OR t.scope <> 'business')
       ORDER BY t.uses DESC, t.name`,
      [actor.id, parseInt(req.query.business_id, 10) || null]
    )).rows;
    res.json({ templates: rows.map((r) => ({ ...r, can_edit: canEdit(actor, r) })) });
  } catch (err) {
    next(err);
  }
});

async function loadTemplate(actor, id) {
  const row = (await db.query(
    `${SELECT}, t.tree FROM todo_templates t
     LEFT JOIN businesses b ON b.id = t.business_id
     LEFT JOIN users u ON u.id = t.owner_id
     WHERE t.id = $2 AND ${VISIBLE}`,
    [actor.id, id]
  )).rows[0];
  return row ? { ...row, can_edit: canEdit(actor, row) } : null;
}

// GET /api/templates/:id — with the full tree
router.get('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const template = await loadTemplate(actor, parseInt(req.params.id, 10));
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    next(err);
  }
});

// POST /api/templates — { name, description?, scope?, business_id?, tree }
router.post('/', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Give the template a name' });
    const where = await resolveScope(actor, req.body);
    if (where.error) return res.status(where.status).json({ error: where.error });
    const { tree, count, error } = sanitizeTree(req.body.tree);
    if (error) return res.status(400).json({ error });
    const row = (await db.query(
      `INSERT INTO todo_templates (owner_id, name, description, scope, business_id, tree, item_count)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
      [actor.id, name, sanitizeText(req.body.description, 500), where.scope, where.businessId, JSON.stringify(tree), count]
    )).rows[0];
    res.status(201).json({ template: await loadTemplate(actor, row.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/templates/from-todo/:todoId — save an existing to-do, with everything below it, as a template
router.post('/from-todo/:todoId(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const root = await getTodoFor(parseInt(req.params.todoId, 10), actor.id, actor);
    if (!root) return res.status(404).json({ error: 'To-do not found' });
    const name = sanitizeText(req.body.name, 120) || root.title.slice(0, 120);
    const where = await resolveScope(actor, req.body);
    if (where.error) return res.status(where.status).json({ error: where.error });

    const rows = [root];
    const walk = async (parentId) => {
      const kids = await listTodos(actor.id, { actor, where: 't.parent_id = $5', params: [parentId], tail: 'ORDER BY t.id' });
      for (const kid of kids) {
        rows.push(kid);
        if (rows.length > 150) return;
        await walk(kid.id);
      }
    };
    await walk(root.id);
    const { tree, count, error } = sanitizeTree(treeFromRows(rows, root.id));
    if (error) return res.status(400).json({ error });
    const row = (await db.query(
      `INSERT INTO todo_templates (owner_id, name, description, scope, business_id, tree, item_count)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
      [actor.id, name, sanitizeText(req.body.description, 500), where.scope, where.businessId, JSON.stringify(tree), count]
    )).rows[0];
    res.status(201).json({ template: await loadTemplate(actor, row.id) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/templates/:id — { name?, description?, tree? }
router.put('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const id = parseInt(req.params.id, 10);
    const existing = await loadTemplate(actor, id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    if (!existing.can_edit) return res.status(403).json({ error: 'Only its owner can change this template' });
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : existing.name;
    if (!name) return res.status(400).json({ error: 'Give the template a name' });
    let tree = existing.tree;
    let count = existing.item_count;
    if (req.body.tree !== undefined) {
      const out = sanitizeTree(req.body.tree);
      if (out.error) return res.status(400).json({ error: out.error });
      tree = out.tree;
      count = out.count;
    }
    await db.query(
      `UPDATE todo_templates SET name = $2, description = $3, tree = $4::jsonb, item_count = $5, updated_at = NOW() WHERE id = $1`,
      [id, name, req.body.description !== undefined ? sanitizeText(req.body.description, 500) : existing.description, JSON.stringify(tree), count]
    );
    res.json({ template: await loadTemplate(actor, id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/templates/:id
router.delete('/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const existing = await loadTemplate(actor, parseInt(req.params.id, 10));
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    if (!existing.can_edit) return res.status(403).json({ error: 'Only its owner can delete this template' });
    await db.query('DELETE FROM todo_templates WHERE id = $1', [existing.id]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/templates/:id/use — { start_date?, business_id?, list_id?, assign_to? }
// Creates the whole tree: due dates are offsets from start_date (today by default), {month} and friends in
// titles are filled in, and only the top task notifies people. Each task goes through the normal creation
// rules, so a business task from someone who does not manage the business becomes a proposal as usual.
router.post('/:id(\\d+)/use', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const template = await loadTemplate(actor, parseInt(req.params.id, 10));
    if (!template) return res.status(404).json({ error: 'Template not found' });
    const { createTodoCore, announce } = todoRoutes();

    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.start_date || '')) ? req.body.start_date : todayInAppZone();
    const businessId = parseInt(req.body.business_id, 10) || (template.scope === 'business' ? template.business_id : null);
    const results = { created: 0, skipped: 0, ids: [] };
    let rootId = null;

    const make = async (node, parentId, isRoot) => {
      const body = {
        title: fillTokens(node.title, start),
        notes: node.notes ? fillTokens(node.notes, start) : '',
        priority: node.priority || 4,
        due_date: node.offset_days !== undefined ? addDays(start, node.offset_days) : (isRoot ? start : null),
        due_time: node.due_time || null,
        deadline_date: node.deadline_offset_days !== undefined ? addDays(start, node.deadline_offset_days) : null,
        duration_minutes: node.duration_minutes || null,
        labels: node.labels || [],
        recurrence: isRoot ? node.recurrence : undefined,
        parent_id: parentId || undefined,
        business_id: isRoot ? businessId : undefined,
        list_id: isRoot ? req.body.list_id : undefined,
        assign_to: isRoot ? req.body.assign_to : undefined,
      };
      const out = await createTodoCore(actor, body, { quiet: !isRoot });
      if (out.error) {
        if (isRoot) return { error: out };
        results.skipped += 1;
        return {};
      }
      results.created += 1;
      results.ids.push(out.id);
      if (isRoot) rootId = out.id;
      for (const child of node.children || []) {
        const sub = await make(child, out.id, false);
        if (sub.error) return sub;
      }
      return {};
    };

    for (const node of template.tree) {
      const failed = await make(node, null, true);
      if (failed.error) {
        return res.status(failed.error.status).json({ error: failed.error.error });
      }
    }
    await db.query('UPDATE todo_templates SET uses = uses + 1 WHERE id = $1', [template.id]);
    if (rootId) await announce(rootId, 'updated');
    res.status(201).json({ ...results, todo_id: rootId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
