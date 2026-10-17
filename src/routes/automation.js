const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { loadActor } = require('../utils/org');
const catalog = require('../utils/automation/catalog');
const engine = require('../services/automation/engine');

const router = express.Router();

const LIMITS = { profiles: 30, tasks: 80 };
const NAME = /^[A-Z][A-Z0-9_]{0,38}$/;

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const eventOf = (contexts) => (contexts || []).find((c) => catalog.CONTEXTS[c.type] && catalog.CONTEXTS[c.type].kind === 'event');

async function actorOf(req, res) {
  const actor = await loadActor(req.user.id);
  if (!actor || actor.status === 'inactive') {
    res.status(403).json({ error: 'Account is inactive' });
    return null;
  }
  return actor;
}

const hookBase = (req) => `${req.protocol}://${req.get('host')}/api/automation/hook/`;

function shapeProfile(row, req) {
  const hasHook = (row.contexts || []).some((c) => c.type === 'webhook');
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    contexts: row.contexts,
    kind: eventOf(row.contexts) ? 'event' : 'state',
    match_mode: row.match_mode,
    enter_task_id: row.enter_task_id,
    exit_task_id: row.exit_task_id,
    enter_task_name: row.enter_task_name || null,
    exit_task_name: row.exit_task_name || null,
    cooldown_seconds: row.cooldown_seconds,
    active: row.active,
    run_count: row.run_count,
    last_fired_at: row.last_fired_at,
    hook_url: hasHook && row.hook_token ? hookBase(req) + row.hook_token : null,
    created_at: row.created_at,
  };
}

const PROFILE_SELECT = `SELECT p.*, et.name AS enter_task_name, xt.name AS exit_task_name
  FROM automation_profiles p
  LEFT JOIN automation_tasks et ON et.id = p.enter_task_id
  LEFT JOIN automation_tasks xt ON xt.id = p.exit_task_id`;

async function ownedTaskId(ownerId, value) {
  const id = parseInt(value, 10);
  if (!id) return null;
  const row = (await db.query('SELECT id FROM automation_tasks WHERE id = $1 AND owner_id = $2', [id, ownerId])).rows[0];
  return row ? row.id : undefined; // undefined = not theirs
}

/** Check and clean a profile body. Returns { error } or { values }. */
async function profileValues(actor, body, existing = null) {
  const name = clip(body.name !== undefined ? body.name : existing && existing.name, 80);
  if (!name) return { error: 'Give it a name' };
  const { contexts, errors } = catalog.cleanContexts(body.contexts !== undefined ? body.contexts : existing && existing.contexts);
  if (errors.length) return { error: errors[0] };
  const enter = body.enter_task_id !== undefined ? await ownedTaskId(actor.id, body.enter_task_id) : existing && existing.enter_task_id;
  const exit = body.exit_task_id !== undefined ? await ownedTaskId(actor.id, body.exit_task_id) : existing && existing.exit_task_id;
  if (enter === undefined || exit === undefined) return { error: 'That task was not found' };
  const cooldown = body.cooldown_seconds !== undefined ? Math.min(86400, Math.max(0, parseInt(body.cooldown_seconds, 10) || 0)) : (existing ? existing.cooldown_seconds : 5);
  const hook = contexts.some((c) => c.type === 'webhook') ? ((existing && existing.hook_token) || crypto.randomBytes(18).toString('hex')) : null;
  return {
    values: {
      name,
      description: clip(body.description !== undefined ? body.description : existing && existing.description, 300),
      contexts,
      match_mode: (body.match_mode || (existing && existing.match_mode)) === 'any' ? 'any' : 'all',
      enter_task_id: enter || null,
      exit_task_id: exit || null,
      cooldown_seconds: cooldown,
      hook_token: hook,
      enabled: body.enabled !== undefined ? !!body.enabled : (existing ? existing.enabled : true),
    },
  };
}

async function taskValues(actor, body, existing = null) {
  const name = clip(body.name !== undefined ? body.name : existing && existing.name, 80);
  if (!name) return { error: 'Give it a name' };
  const { actions, errors } = catalog.cleanTask(body.actions !== undefined ? body.actions : existing && existing.actions, { canUseWeb: actor.can('automation_web') });
  if (errors.length) return { error: `Action ${errors[0].index + 1}: ${errors[0].message}`, errors };
  return { values: { name, description: clip(body.description !== undefined ? body.description : existing && existing.description, 300), actions } };
}

// GET /api/automation — everything the screen needs in one go
router.get('/', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const [profiles, tasks, vars] = await Promise.all([
      db.query(`${PROFILE_SELECT} WHERE p.owner_id = $1 ORDER BY p.enabled DESC, p.priority, p.id DESC`, [actor.id]),
      db.query(`SELECT id, name, description, jsonb_array_length(actions) AS action_count, updated_at,
                  (SELECT COUNT(*)::int FROM automation_profiles p WHERE p.enter_task_id = automation_tasks.id OR p.exit_task_id = automation_tasks.id) AS used_by
                FROM automation_tasks WHERE owner_id = $1 ORDER BY name`, [actor.id]),
      db.query('SELECT name, value FROM automation_vars WHERE owner_id = $1 ORDER BY name', [actor.id]),
    ]);
    res.json({
      profiles: profiles.rows.map((r) => shapeProfile(r, req)),
      tasks: tasks.rows,
      vars: vars.rows,
      can_web: actor.can('automation_web'),
      limits: LIMITS,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/catalog', authenticate, async (req, res, next) => {
  try {
    res.json(catalog.publicCatalog());
  } catch (err) {
    next(err);
  }
});

// ---- profiles ---------------------------------------------------------------------------------------

router.get('/profiles/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1 AND p.owner_id = $2`, [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

router.post('/profiles', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM automation_profiles WHERE owner_id = $1', [actor.id])).rows[0].n;
    if (count >= LIMITS.profiles) return res.status(400).json({ error: `You can have up to ${LIMITS.profiles} profiles` });
    const out = await profileValues(actor, req.body);
    if (out.error) return res.status(400).json({ error: out.error });
    const v = out.values;
    const inserted = await db.query(
      `INSERT INTO automation_profiles (owner_id, name, description, enabled, contexts, match_mode, enter_task_id, exit_task_id, cooldown_seconds, hook_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [actor.id, v.name, v.description, v.enabled, JSON.stringify(v.contexts), v.match_mode, v.enter_task_id, v.exit_task_id, v.cooldown_seconds, v.hook_token]
    );
    engine.invalidate();
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1`, [inserted.rows[0].id])).rows[0];
    res.status(201).json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

router.put('/profiles/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = (await db.query('SELECT * FROM automation_profiles WHERE id = $1 AND owner_id = $2', [req.params.id, actor.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const out = await profileValues(actor, req.body, existing);
    if (out.error) return res.status(400).json({ error: out.error });
    const v = out.values;
    // Changing what a profile listens for starts it fresh: it is not "active" until it is checked again.
    const contextsChanged = JSON.stringify(v.contexts) !== JSON.stringify(existing.contexts);
    await db.query(
      `UPDATE automation_profiles SET name = $3, description = $4, enabled = $5, contexts = $6, match_mode = $7, enter_task_id = $8,
         exit_task_id = $9, cooldown_seconds = $10, hook_token = $11, active = CASE WHEN $12::boolean OR NOT $5 THEN FALSE ELSE active END,
         last_slot = CASE WHEN $12::boolean THEN NULL ELSE last_slot END, updated_at = NOW()
       WHERE id = $1 AND owner_id = $2`,
      [existing.id, actor.id, v.name, v.description, v.enabled, JSON.stringify(v.contexts), v.match_mode, v.enter_task_id, v.exit_task_id, v.cooldown_seconds, v.hook_token, contextsChanged]
    );
    engine.invalidate();
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1`, [existing.id])).rows[0];
    res.json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

router.delete('/profiles/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM automation_profiles WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
    engine.invalidate();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/profiles/:id(\\d+)/duplicate', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM automation_profiles WHERE owner_id = $1', [actor.id])).rows[0].n;
    if (count >= LIMITS.profiles) return res.status(400).json({ error: `You can have up to ${LIMITS.profiles} profiles` });
    const src = (await db.query('SELECT * FROM automation_profiles WHERE id = $1 AND owner_id = $2', [req.params.id, actor.id])).rows[0];
    if (!src) return res.status(404).json({ error: 'Not found' });
    const hook = (src.contexts || []).some((c) => c.type === 'webhook') ? crypto.randomBytes(18).toString('hex') : null;
    const inserted = await db.query(
      `INSERT INTO automation_profiles (owner_id, name, description, enabled, contexts, match_mode, enter_task_id, exit_task_id, cooldown_seconds, hook_token)
       VALUES ($1, $2, $3, FALSE, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [actor.id, `${src.name} copy`.slice(0, 80), src.description, JSON.stringify(src.contexts), src.match_mode, src.enter_task_id, src.exit_task_id, src.cooldown_seconds, hook]
    );
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1`, [inserted.rows[0].id])).rows[0];
    res.status(201).json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

// New secret link (the old one stops working)
router.post('/profiles/:id(\\d+)/new-link', authenticate, async (req, res, next) => {
  try {
    const out = await db.query(
      `UPDATE automation_profiles SET hook_token = $3 WHERE id = $1 AND owner_id = $2 AND hook_token IS NOT NULL RETURNING id`,
      [req.params.id, req.user.id, crypto.randomBytes(18).toString('hex')]
    );
    if (!out.rows.length) return res.status(404).json({ error: 'This profile has no web link' });
    engine.invalidate();
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1`, [req.params.id])).rows[0];
    res.json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

router.post('/profiles/:id(\\d+)/run', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query('SELECT * FROM automation_profiles WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    const out = await engine.runProfileNow(row, req.user.id, req.body.which === 'exit' ? 'exit' : 'enter');
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.get('/profiles/:id(\\d+)/export', authenticate, async (req, res, next) => {
  try {
    const p = (await db.query('SELECT * FROM automation_profiles WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'Not found' });
    const tasks = {};
    for (const [slot, id] of [['enter', p.enter_task_id], ['exit', p.exit_task_id]]) {
      if (!id) continue;
      const t = (await db.query('SELECT name, description, actions FROM automation_tasks WHERE id = $1', [id])).rows[0];
      if (t) tasks[slot] = t;
    }
    res.json({ format: 'taskhub-automation-1', profile: { name: p.name, description: p.description, contexts: p.contexts, match_mode: p.match_mode, cooldown_seconds: p.cooldown_seconds }, tasks });
  } catch (err) {
    next(err);
  }
});

// Bring in a profile that was exported (or built by hand). It always arrives switched off.
router.post('/import', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const doc = req.body.doc;
    if (!doc || doc.format !== 'taskhub-automation-1' || !doc.profile) return res.status(400).json({ error: 'That is not an automation file' });
    const made = await createFromDoc(actor, doc);
    if (made.error) return res.status(400).json({ error: made.error });
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1`, [made.profileId])).rows[0];
    res.status(201).json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

/** Create the tasks and the profile of a ready-made recipe or an imported file. Returns { profileId } or { error }. */
async function createFromDoc(actor, doc, { enabled = false } = {}) {
  const profileCount = (await db.query('SELECT COUNT(*)::int AS n FROM automation_profiles WHERE owner_id = $1', [actor.id])).rows[0].n;
  const taskCount = (await db.query('SELECT COUNT(*)::int AS n FROM automation_tasks WHERE owner_id = $1', [actor.id])).rows[0].n;
  const slots = Object.keys(doc.tasks || {}).filter((s) => ['enter', 'exit'].includes(s));
  if (profileCount >= LIMITS.profiles) return { error: `You can have up to ${LIMITS.profiles} profiles` };
  if (taskCount + slots.length > LIMITS.tasks) return { error: `You can have up to ${LIMITS.tasks} tasks` };
  const ids = {};
  for (const slot of slots) {
    const t = doc.tasks[slot];
    const out = await taskValues(actor, { name: t.name, description: t.description, actions: t.actions });
    if (out.error) return { error: out.error };
    const row = await db.query(
      'INSERT INTO automation_tasks (owner_id, name, description, actions) VALUES ($1, $2, $3, $4) RETURNING id',
      [actor.id, out.values.name, out.values.description, JSON.stringify(out.values.actions)]
    );
    ids[slot] = row.rows[0].id;
  }
  const pv = await profileValues(actor, { ...doc.profile, enter_task_id: ids.enter || null, exit_task_id: ids.exit || null, enabled });
  if (pv.error) return { error: pv.error };
  const v = pv.values;
  const inserted = await db.query(
    `INSERT INTO automation_profiles (owner_id, name, description, enabled, contexts, match_mode, enter_task_id, exit_task_id, cooldown_seconds, hook_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [actor.id, v.name, v.description, v.enabled, JSON.stringify(v.contexts), v.match_mode, v.enter_task_id, v.exit_task_id, v.cooldown_seconds, v.hook_token]
  );
  engine.invalidate();
  return { profileId: inserted.rows[0].id };
}

router.post('/recipes/:id/add', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const recipe = catalog.RECIPES.find((r) => r.id === req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Not found' });
    const tasks = { enter: recipe.enter };
    if (recipe.exit) tasks.exit = recipe.exit;
    const made = await createFromDoc(actor, { profile: recipe.profile, tasks }, { enabled: true });
    if (made.error) return res.status(400).json({ error: made.error });
    const row = (await db.query(`${PROFILE_SELECT} WHERE p.id = $1`, [made.profileId])).rows[0];
    res.status(201).json({ profile: shapeProfile(row, req) });
  } catch (err) {
    next(err);
  }
});

// ---- tasks ------------------------------------------------------------------------------------------

router.get('/tasks/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query('SELECT id, name, description, actions FROM automation_tasks WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ task: row });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM automation_tasks WHERE owner_id = $1', [actor.id])).rows[0].n;
    if (count >= LIMITS.tasks) return res.status(400).json({ error: `You can have up to ${LIMITS.tasks} tasks` });
    const out = await taskValues(actor, req.body);
    if (out.error) return res.status(400).json({ error: out.error, errors: out.errors });
    const row = await db.query(
      'INSERT INTO automation_tasks (owner_id, name, description, actions) VALUES ($1, $2, $3, $4) RETURNING id, name, description, actions',
      [actor.id, out.values.name, out.values.description, JSON.stringify(out.values.actions)]
    );
    res.status(201).json({ task: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/tasks/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const existing = (await db.query('SELECT * FROM automation_tasks WHERE id = $1 AND owner_id = $2', [req.params.id, actor.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const out = await taskValues(actor, req.body, existing);
    if (out.error) return res.status(400).json({ error: out.error, errors: out.errors });
    const row = await db.query(
      'UPDATE automation_tasks SET name = $3, description = $4, actions = $5, updated_at = NOW() WHERE id = $1 AND owner_id = $2 RETURNING id, name, description, actions',
      [existing.id, actor.id, out.values.name, out.values.description, JSON.stringify(out.values.actions)]
    );
    res.json({ task: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete('/tasks/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM automation_tasks WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
    engine.invalidate();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:id(\\d+)/duplicate', authenticate, async (req, res, next) => {
  try {
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM automation_tasks WHERE owner_id = $1', [req.user.id])).rows[0].n;
    if (count >= LIMITS.tasks) return res.status(400).json({ error: `You can have up to ${LIMITS.tasks} tasks` });
    const row = await db.query(
      `INSERT INTO automation_tasks (owner_id, name, description, actions)
       SELECT owner_id, LEFT(name || ' copy', 80), description, actions FROM automation_tasks WHERE id = $1 AND owner_id = $2
       RETURNING id, name, description, actions`,
      [req.params.id, req.user.id]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ task: row.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/tasks/:id(\\d+)/run', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query('SELECT id, name, actions FROM automation_tasks WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    const out = await engine.runTaskNow(row, req.user.id, clip(req.body.par1, 500));
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// Try actions that are not saved yet (the editor's "Test")
router.post('/run-draft', authenticate, async (req, res, next) => {
  try {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const { actions, errors } = catalog.cleanTask(req.body.actions, { canUseWeb: actor.can('automation_web') });
    if (errors.length) return res.status(400).json({ error: `Action ${errors[0].index + 1}: ${errors[0].message}`, errors });
    const out = await engine.runTaskNow({ id: null, name: clip(req.body.name, 80) || 'Test', actions }, actor.id, '');
    if (out.error) return res.status(400).json({ error: out.error });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ---- variables ---------------------------------------------------------------------------------------

router.put('/vars/:name', authenticate, async (req, res, next) => {
  try {
    const name = String(req.params.name || '').toUpperCase();
    if (!NAME.test(name)) return res.status(400).json({ error: 'Names use capital letters, digits and _' });
    const count = (await db.query('SELECT COUNT(*)::int AS n FROM automation_vars WHERE owner_id = $1 AND name <> $2', [req.user.id, name])).rows[0].n;
    if (count >= 100) return res.status(400).json({ error: 'You can keep up to 100 variables' });
    await db.query(
      `INSERT INTO automation_vars (owner_id, name, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, name) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.user.id, name, clip(req.body.value, 2000)]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/vars/:name', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM automation_vars WHERE owner_id = $1 AND name = $2', [req.user.id, String(req.params.name).toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- run log -----------------------------------------------------------------------------------------

router.get('/runs', authenticate, async (req, res, next) => {
  try {
    const profileId = parseInt(req.query.profile_id, 10) || null;
    const rows = (await db.query(
      `SELECT id, profile_id, task_id, profile_name, task_name, trigger, status, error, steps, duration_ms, started_at
       FROM automation_runs WHERE owner_id = $1 AND ($2::int IS NULL OR profile_id = $2) ORDER BY started_at DESC, id DESC LIMIT 60`,
      [req.user.id, profileId]
    )).rows;
    res.json({ runs: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/runs/:id(\\d+)', authenticate, async (req, res, next) => {
  try {
    const row = (await db.query('SELECT * FROM automation_runs WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ run: row });
  } catch (err) {
    next(err);
  }
});

router.delete('/runs', authenticate, async (req, res, next) => {
  try {
    await db.query('DELETE FROM automation_runs WHERE owner_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- the device --------------------------------------------------------------------------------------

// Which readings from the phone any switched-on profile needs. The app only reads (and sends) these.
router.get('/sensors', authenticate, async (req, res, next) => {
  try {
    const rows = (await db.query('SELECT contexts FROM automation_profiles WHERE owner_id = $1 AND enabled', [req.user.id])).rows;
    const types = new Set(rows.flatMap((r) => (r.contexts || []).map((c) => c.type)));
    res.json({ battery: types.has('battery'), location: types.has('place') });
  } catch (err) {
    next(err);
  }
});

router.put('/device', authenticate, async (req, res, next) => {
  try {
    const b = req.body || {};
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
    const patch = {};
    if (num(b.battery, 0, 100) !== undefined) patch.battery = Math.round(b.battery);
    if (typeof b.charging === 'boolean') patch.charging = b.charging;
    if (typeof b.online === 'boolean') patch.online = b.online;
    if (num(b.lat, -90, 90) !== undefined && num(b.lon, -180, 180) !== undefined) { patch.lat = b.lat; patch.lon = b.lon; }
    if (!Object.keys(patch).length) return res.json({ ok: true });
    await db.query(
      `INSERT INTO automation_device (owner_id, state) VALUES ($1, $2)
       ON CONFLICT (owner_id) DO UPDATE SET state = automation_device.state || EXCLUDED.state, updated_at = NOW()`,
      [req.user.id, JSON.stringify(patch)]
    );
    engine.evaluateStatesFor(req.user.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- the secret web link (no login: the link is the key) ---------------------------------------------

const hookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.params.token,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many calls to this link, slow down' },
});

async function hook(req, res, next) {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{36}$/.test(token)) return res.status(404).json({ error: 'Not found' });
    const profile = (await db.query(
      `SELECT p.* FROM automation_profiles p JOIN users u ON u.id = p.owner_id
       WHERE p.hook_token = $1 AND p.enabled AND u.status != 'inactive'`, [token]
    )).rows[0];
    if (!profile) return res.status(404).json({ error: 'Not found' });
    const body = req.body;
    const vars = { hook_query: JSON.stringify(req.query || {}).slice(0, 2000) };
    let text = '';
    if (typeof body === 'string') text = body;
    else if (body && typeof body === 'object' && Object.keys(body).length) {
      text = [body.text, body.title, body.body, body.message].find((v) => typeof v === 'string' && v) || JSON.stringify(body);
      vars.hook_json = JSON.stringify(body).slice(0, 4000);
      for (const [k, v] of Object.entries(body).slice(0, 30)) {
        if (v !== null && typeof v !== 'object') vars[`hook_${k.replace(/[^A-Za-z0-9_]/g, '_')}`] = String(v).slice(0, 1000);
      }
    } else if (req.query && typeof req.query.text === 'string') text = req.query.text;
    vars.hook_body = String(text).slice(0, 4000);
    engine.runWebhook(profile, vars).catch((err) => console.error('[automation] web link run failed:', err.message));
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
}
router.post('/hook/:token', hookLimiter, express.text({ type: 'text/*', limit: '20kb' }), hook);
router.get('/hook/:token', hookLimiter, hook);

module.exports = router;
