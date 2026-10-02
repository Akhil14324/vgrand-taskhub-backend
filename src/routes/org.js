const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText, validatePassword } = require('../middleware/sanitize');
const { USERNAME_PATTERN, USERNAME_RULE, cleanUsername, suggestUsername } = require('../utils/mentions');
const { notify } = require('../utils/notify');
const {
  LEADERSHIP,
  DESIGNATIONS,
  isValidDesignation,
  designationLevel,
  roleForOrgLevel,
  globalLevel,
  displayTitle,
  levelWithDesignation,
  loadActor,
  actorLevelIn,
  actorBestLevel,
  isPortalAdmin,
  managesBusiness,
} = require('../utils/org');
const { generateTempPassword, setMemberships, syncLeaderGroups } = require('../services/org');

const router = express.Router();

async function requirePortal(req, res, next) {
  try {
    const actor = await loadActor(req.user.id);
    if (!isPortalAdmin(actor)) {
      return res.status(403).json({ error: 'Only the Chairman and Chief of Staff can manage the organisation' });
    }
    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

/** Can the actor manage this person? Strictly more senior, never yourself. */
async function canManage(actor, targetId) {
  if (actor.id === Number(targetId)) return false;
  const target = await loadActor(targetId);
  if (!target) return false;
  return actorBestLevel(actor) < actorBestLevel(target);
}

function catalog() {
  return {
    leadership: Object.entries(LEADERSHIP).map(([level, v]) => ({ level: Number(level), ...v })),
    designations: Object.entries(DESIGNATIONS).map(([key, v]) => ({ key, ...v })),
  };
}

const PERSON_SELECT = `
  SELECT u.id, u.name, u.username, u.role, u.status, u.org_level, u.title, u.profile_picture,
         u.must_change_password, u.created_at, u.last_seen,
         COALESCE(json_agg(json_build_object(
           'business_id', b.id, 'business_name', b.name, 'business_color', b.color,
           'designation', ub.designation, 'title', ub.title
         ) ORDER BY b.sort_order, b.name) FILTER (WHERE b.id IS NOT NULL), '[]') AS memberships
  FROM users u
  LEFT JOIN user_businesses ub ON ub.user_id = u.id
  LEFT JOIN businesses b ON b.id = ub.business_id`;

function decoratePerson(p) {
  const best = Math.min(
    globalLevel(p) ?? 99,
    ...p.memberships.map((m) => designationLevel(m.designation))
  );
  return {
    ...p,
    level: best === 99 ? null : best,
    display_title: displayTitle(p, p.memberships[0]?.designation, p.memberships[0]?.title),
    memberships: p.memberships.map((m) => ({
      ...m,
      designation_label: DESIGNATIONS[m.designation]?.label || 'Member',
      level: designationLevel(m.designation),
    })),
  };
}

// GET /api/org/catalog — leadership tiers and business designations
router.get('/catalog', authenticate, (req, res) => {
  res.json(catalog());
});

// GET /api/org/structure — the org chart (visible to everyone)
router.get('/structure', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const [people, businesses] = await Promise.all([
      db.query(`${PERSON_SELECT} WHERE u.status != 'inactive' GROUP BY u.id ORDER BY u.org_level NULLS LAST, u.name`),
      db.query(
        `SELECT b.id, b.name, b.type, b.color, b.description, b.sort_order,
           COUNT(t.id) FILTER (WHERE t.status != 'done')::int AS open_tasks,
           COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_tasks,
           COUNT(t.id) FILTER (WHERE t.due_date < CURRENT_DATE AND t.status NOT IN ('done', 'on_hold'))::int AS overdue_tasks
         FROM businesses b
         LEFT JOIN todos t ON t.business_id = b.id AND t.parent_id IS NULL AND t.review_state = 'accepted'
         GROUP BY b.id
         ORDER BY b.sort_order, b.name`
      ),
    ]);

    const persons = people.rows.map(decoratePerson);
    const brief = (p, extra = {}) => ({
      id: p.id,
      name: p.name,
      username: p.username,
      profile_picture: p.profile_picture,
      last_seen: p.last_seen,
      org_level: p.org_level,
      title: p.title,
      display_title: p.display_title,
      ...extra,
    });

    const leaders = persons
      .filter((p) => p.org_level && LEADERSHIP[p.org_level])
      .map((p) => brief(p, { tier: LEADERSHIP[p.org_level].label }));

    const businessNodes = businesses.rows.map((b) => {
      const members = [];
      for (const p of persons) {
        const m = p.memberships.find((x) => x.business_id === b.id);
        if (!m) continue;
        members.push(brief(p, {
          designation: m.designation,
          designation_label: m.designation_label,
          membership_title: m.title,
          level: m.level,
          is_leader: !!p.org_level,
        }));
      }
      members.sort((a, c) => a.level - c.level || a.name.localeCompare(c.name));
      return { ...b, heads: members.filter((m) => m.designation === 'head'), members };
    });

    const portal = isPortalAdmin(actor);
    const unplaced = portal
      ? persons
        .filter((p) => !p.org_level && p.memberships.length === 0 && globalLevel(p) !== 0)
        .map((p) => brief(p))
      : [];

    res.json({
      leaders,
      businesses: businessNodes,
      unplaced,
      me: { id: actor.id, level: actorBestLevel(actor), portal },
      ...catalog(),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/org/directory?q= — everyone, for @mentions, pickers and "who's who"
router.get('/directory', authenticate, async (req, res, next) => {
  try {
    const q = sanitizeText(req.query.q, 50);
    const params = [];
    let filter = `WHERE u.status != 'inactive'`;
    if (q) {
      params.push(`%${q}%`);
      filter += ` AND (u.name ILIKE $1 OR u.username ILIKE $1)`;
    }
    const result = await db.query(`${PERSON_SELECT} ${filter} GROUP BY u.id ORDER BY u.org_level NULLS LAST, u.name LIMIT 200`, params);
    res.json({
      users: result.rows.map((p) => {
        const d = decoratePerson(p);
        return {
          id: d.id,
          name: d.name,
          username: d.username,
          profile_picture: d.profile_picture,
          display_title: d.display_title,
          level: d.level,
          businesses: d.memberships.map((m) => ({ id: m.business_id, name: m.business_name, designation: m.designation })),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Portal: people management (Chairman + Chief of Staff)
// ---------------------------------------------------------------------------

// GET /api/org/people — everyone with full placement details
router.get('/people', authenticate, requirePortal, async (req, res, next) => {
  try {
    const result = await db.query(`${PERSON_SELECT} GROUP BY u.id ORDER BY u.org_level NULLS LAST, u.name`);
    const myLevel = actorBestLevel(req.actor);
    res.json({
      people: result.rows.map(decoratePerson).map((p) => ({
        ...p,
        can_manage: p.id !== req.actor.id && myLevel < (p.level ?? 99),
      })),
      me: { id: req.actor.id, level: myLevel },
      ...catalog(),
    });
  } catch (err) {
    next(err);
  }
});

function validateOrgLevel(actor, orgLevel) {
  if (orgLevel === null) return null;
  if (!LEADERSHIP[orgLevel]) return 'Unknown leadership tier';
  if (orgLevel <= actorBestLevel(actor)) return 'You can only place people below your own level';
  return null;
}

// POST /api/org/people — { name, username, password?, org_level?, title?, memberships: [{ business_id, designation, title? }] }
router.post('/people', authenticate, requirePortal, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const name = sanitizeText(req.body.name, 100);
    const orgLevel = req.body.org_level ? parseInt(req.body.org_level) : null;
    const title = sanitizeText(req.body.title, 100) || null;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    // Lowercase only; left empty, a free one is made from the name.
    const username = cleanUsername(req.body.username) || await suggestUsername(name, client);
    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: USERNAME_RULE });
    }
    const levelError = validateOrgLevel(req.actor, orgLevel);
    if (levelError) return res.status(403).json({ error: levelError });

    const exists = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });

    let password = req.body.password ? String(req.body.password) : null;
    const generated = !password;
    if (generated) password = generateTempPassword();
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const role = roleForOrgLevel(orgLevel);
    const inserted = await client.query(
      `INSERT INTO users (name, username, password_hash, role, status, org_level, title, must_change_password)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, TRUE) RETURNING id`,
      [name, username, hash, role, orgLevel, title]
    );
    const userId = inserted.rows[0].id;
    await setMemberships(client, userId, req.body.memberships || []);
    if (role !== 'user') await syncLeaderGroups(client, userId, role);
    await client.query('COMMIT');

    await notify([userId], {
      type: 'assignment',
      title: `Welcome to TaskHub, ${name.split(' ')[0]}`,
      body: `${req.actor.name} added you to the organisation.`,
      data: {},
    }, { push: false });

    const person = await db.query(`${PERSON_SELECT} WHERE u.id = $1 GROUP BY u.id`, [userId]);
    res.status(201).json({ person: decoratePerson(person.rows[0]), temp_password: password, generated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/org/people/:id — { name?, title?, org_level?, status?, memberships? }
router.put('/people/:id', authenticate, requirePortal, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const targetId = parseInt(req.params.id);
    const isSelf = targetId === req.actor.id;
    const targetRes = await client.query('SELECT * FROM users WHERE id = $1', [targetId]);
    const target = targetRes.rows[0];
    if (!target) return res.status(404).json({ error: 'Person not found' });
    if (!isSelf && !(await canManage(req.actor, targetId))) {
      return res.status(403).json({ error: 'You can only manage people below you in the hierarchy' });
    }

    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 100) : target.name;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const title = req.body.title !== undefined ? (sanitizeText(req.body.title, 100) || null) : target.title;

    let orgLevel = target.org_level;
    let status = target.status;
    if (!isSelf) {
      if (req.body.org_level !== undefined) {
        orgLevel = req.body.org_level ? parseInt(req.body.org_level) : null;
        const levelError = validateOrgLevel(req.actor, orgLevel);
        if (levelError) return res.status(403).json({ error: levelError });
      }
      if (req.body.status !== undefined) {
        if (!['active', 'inactive'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
        status = req.body.status === 'active' && target.status === 'warned' ? 'warned' : req.body.status;
      }
    }

    // The system owner account (role super_admin without a tier) keeps its role.
    const isSystemOwner = target.role === 'super_admin' && !target.org_level;
    const role = isSystemOwner ? target.role : roleForOrgLevel(orgLevel);

    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET name = $1, title = $2, org_level = $3, role = $4, status = $5 WHERE id = $6`,
      [name, title, isSystemOwner ? null : orgLevel, role, status, targetId]
    );
    let membershipChange = null;
    if (Array.isArray(req.body.memberships)) {
      membershipChange = await setMemberships(client, targetId, req.body.memberships);
    }
    if (role !== target.role) await syncLeaderGroups(client, targetId, role);
    await client.query('COMMIT');

    if (!isSelf && (orgLevel !== target.org_level || membershipChange?.added?.length)) {
      const levelLabel = orgLevel && LEADERSHIP[orgLevel] ? LEADERSHIP[orgLevel].label : null;
      await notify([targetId], {
        type: 'assignment',
        title: 'Your position was updated',
        body: levelLabel
          ? `${req.actor.name} made you ${levelLabel}.`
          : `${req.actor.name} updated your role and businesses.`,
        data: {},
      });
    }

    const person = await db.query(`${PERSON_SELECT} WHERE u.id = $1 GROUP BY u.id`, [targetId]);
    res.json({ person: decoratePerson(person.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/org/people/:id/password — reset to a temporary password
router.put('/people/:id/password', authenticate, requirePortal, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    if (!(await canManage(req.actor, targetId))) {
      return res.status(403).json({ error: 'You can only reset passwords for people below you' });
    }
    const password = req.body.password ? String(req.body.password) : generateTempPassword();
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW() WHERE id = $2',
      [hash, targetId]
    );
    res.json({ temp_password: password });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/org/people/:id
router.delete('/people/:id', authenticate, requirePortal, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    if (!(await canManage(req.actor, targetId))) {
      return res.status(403).json({ error: 'You can only remove people below you in the hierarchy' });
    }
    await db.query('DELETE FROM users WHERE id = $1', [targetId]);
    res.json({ message: 'Person removed' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Business memberships (portal, or a manager/head for people junior to them)
// ---------------------------------------------------------------------------

async function canPlaceInBusiness(actor, businessId, designation) {
  if (isPortalAdmin(actor)) return true;
  return managesBusiness(actor, businessId) && actorLevelIn(actor, businessId) < designationLevel(designation);
}

// PUT /api/org/businesses/:id/members/:userId — { designation, title? } (adds or updates)
router.put('/businesses/:id/members/:userId', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const businessId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);
    const designation = isValidDesignation(req.body.designation) ? req.body.designation : 'member';
    if (!(await canPlaceInBusiness(actor, businessId, designation))) {
      return res.status(403).json({ error: 'You can only place people below your own level' });
    }
    const current = await db.query(
      `SELECT u.role, u.org_level, ub.designation FROM users u
       LEFT JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $2 WHERE u.id = $1`,
      [userId, businessId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'Person not found' });
    const targetLevel = levelWithDesignation(current.rows[0], current.rows[0].designation);
    if (userId !== actor.id && current.rows[0].designation && actorLevelIn(actor, businessId) >= targetLevel && !isPortalAdmin(actor)) {
      return res.status(403).json({ error: 'You can only manage people below you' });
    }

    const existing = await db.query(
      'SELECT business_id, designation, title FROM user_businesses WHERE user_id = $1',
      [userId]
    );
    const memberships = existing.rows.filter((m) => m.business_id !== businessId);
    memberships.push({ business_id: businessId, designation, title: sanitizeText(req.body.title, 100) || null });
    await setMemberships(db, userId, memberships);

    const biz = await db.query('SELECT name FROM businesses WHERE id = $1', [businessId]);
    if (!current.rows[0].designation && userId !== actor.id) {
      await notify([userId], {
        type: 'assignment',
        title: `You joined ${biz.rows[0]?.name || 'a business'}`,
        body: `${actor.name} added you as ${DESIGNATIONS[designation].label}.`,
        data: {},
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/org/businesses/:id/members/:userId
router.delete('/businesses/:id/members/:userId', authenticate, async (req, res, next) => {
  try {
    const actor = await loadActor(req.user.id);
    const businessId = parseInt(req.params.id);
    const userId = parseInt(req.params.userId);
    const current = await db.query(
      `SELECT u.role, u.org_level, ub.designation FROM users u
       JOIN user_businesses ub ON ub.user_id = u.id AND ub.business_id = $2 WHERE u.id = $1`,
      [userId, businessId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'Not a member of this business' });
    const targetLevel = levelWithDesignation(current.rows[0], current.rows[0].designation);
    if (!isPortalAdmin(actor) && !(managesBusiness(actor, businessId) && actorLevelIn(actor, businessId) < targetLevel)) {
      return res.status(403).json({ error: 'You can only remove people below you' });
    }
    const existing = await db.query('SELECT business_id, designation, title FROM user_businesses WHERE user_id = $1', [userId]);
    await setMemberships(db, userId, existing.rows.filter((m) => m.business_id !== businessId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
