const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/sanitize');
const { loadActor, isLeader, managesBusiness, isValidDesignation } = require('../utils/org');
const { ensureBusinessGroup } = require('../services/org');
const { visibleBusinessIds, buildTree, SITE_KINDS, SITE_STATUSES } = require('../utils/orgTree');

/**
 * Group -> company -> site (migration 053). Mounted at /api/org next to routes/org.js.
 *   GET    /tree                         what the viewer may see, for the sidebar
 *   POST   /sites                        { business_id, name, kind?, status?, address? }
 *   PATCH  /sites/:id                    { name?, kind?, status?, address?, sort_order?, archived? }
 *   POST   /sites/:id/members            { user_id, designation? }  (also places them in the business)
 *   DELETE /sites/:id/members/:userId
 * Sites are changed by leadership and by the people who manage that business.
 */
const router = express.Router();

async function withActor(req, res, next) {
  try {
    req.actor = await loadActor(req.user.id);
    if (!req.actor) return res.status(401).json({ error: 'User not found' });
    next();
  } catch (err) {
    next(err);
  }
}

const canChange = (actor, businessId) => isLeader(actor) || managesBusiness(actor, businessId);

async function siteFor(req, res) {
  const site = (await db.query('SELECT * FROM sites WHERE id = $1', [parseInt(req.params.id, 10) || 0])).rows[0];
  if (!site) { res.status(404).json({ error: 'Site not found' }); return null; }
  if (!canChange(req.actor, site.business_id)) { res.status(403).json({ error: 'You cannot change this site' }); return null; }
  return site;
}

router.get('/tree', authenticate, withActor, async (req, res, next) => {
  try {
    const actor = req.actor;
    const [group, businesses, sites, siteMembers] = await Promise.all([
      db.query('SELECT id, name, logo_url, timezone, working_days, working_hours, week_start, date_format FROM org_groups ORDER BY id LIMIT 1'),
      db.query('SELECT id, name, type, color, sector, logo_url, sort_order FROM businesses ORDER BY sort_order, id'),
      db.query('SELECT id, business_id, name, kind, status, address, sort_order FROM sites WHERE archived_at IS NULL ORDER BY sort_order, id'),
      db.query(
        `SELECT sm.site_id, sm.user_id, sm.designation, u.name
         FROM site_members sm JOIN users u ON u.id = sm.user_id
         WHERE u.status != 'inactive' ORDER BY u.name`
      ),
    ]);
    const mySites = siteMembers.rows.filter((m) => m.user_id === actor.id).map((m) => m.site_id);
    const visible = visibleBusinessIds(actor, sites.rows, mySites);
    res.json(buildTree({
      group: group.rows[0] || null,
      businesses: businesses.rows,
      sites: sites.rows,
      siteMembers: siteMembers.rows,
      visible,
      actor,
      canChange: (id) => canChange(actor, id),
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/sites', authenticate, withActor, async (req, res, next) => {
  try {
    const businessId = parseInt(req.body.business_id, 10) || 0;
    const business = (await db.query('SELECT id FROM businesses WHERE id = $1', [businessId])).rows[0];
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!canChange(req.actor, businessId)) return res.status(403).json({ error: 'You cannot add sites to this business' });
    const name = sanitizeText(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Name the site' });
    const kind = SITE_KINDS.includes(req.body.kind) ? req.body.kind : 'site';
    const status = SITE_STATUSES.includes(req.body.status) ? req.body.status : 'active';
    const order = (await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM sites WHERE business_id = $1', [businessId])).rows[0].n;
    const created = await db.query(
      `INSERT INTO sites (business_id, name, kind, status, address, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_id, name) DO NOTHING RETURNING *`,
      [businessId, name, kind, status, sanitizeText(req.body.address, 500) || null, order]
    );
    if (!created.rows.length) return res.status(409).json({ error: 'This business already has a site with that name' });
    res.status(201).json({ site: created.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/sites/:id(\\d+)', authenticate, withActor, async (req, res, next) => {
  try {
    const site = await siteFor(req, res);
    if (!site) return;
    const name = req.body.name !== undefined ? sanitizeText(req.body.name, 120) : site.name;
    if (!name) return res.status(400).json({ error: 'Name the site' });
    const kind = SITE_KINDS.includes(req.body.kind) ? req.body.kind : site.kind;
    const status = SITE_STATUSES.includes(req.body.status) ? req.body.status : site.status;
    const address = req.body.address !== undefined ? (sanitizeText(req.body.address, 500) || null) : site.address;
    const order = Number.isInteger(req.body.sort_order) ? req.body.sort_order : site.sort_order;
    // Archiving hides a site; it is never deleted from here.
    const archived = req.body.archived === undefined ? null : !!req.body.archived;
    const updated = await db.query(
      `UPDATE sites SET name = $2, kind = $3, status = $4, address = $5, sort_order = $6,
              archived_at = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN COALESCE(archived_at, NOW()) ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [site.id, name, kind, status, address, order, archived]
    );
    res.json({ site: updated.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This business already has a site with that name' });
    next(err);
  }
});

router.post('/sites/:id(\\d+)/members', authenticate, withActor, async (req, res, next) => {
  try {
    const site = await siteFor(req, res);
    if (!site) return;
    const userId = parseInt(req.body.user_id, 10) || 0;
    const person = (await db.query(`SELECT id FROM users WHERE id = $1 AND status != 'inactive'`, [userId])).rows[0];
    if (!person) return res.status(404).json({ error: 'Person not found' });
    const designation = isValidDesignation(req.body.designation) ? req.body.designation : 'member';
    await db.query(
      `INSERT INTO site_members (site_id, user_id, designation) VALUES ($1, $2, $3)
       ON CONFLICT (site_id, user_id) DO UPDATE SET designation = EXCLUDED.designation`,
      [site.id, userId, designation]
    );
    // Someone at a site belongs to its business; an existing, more senior designation there is kept.
    const joined = await db.query(
      `INSERT INTO user_businesses (user_id, business_id, designation) VALUES ($1, $2, 'member')
       ON CONFLICT (user_id, business_id) DO NOTHING RETURNING id`,
      [userId, site.business_id]
    );
    if (joined.rows.length) await ensureBusinessGroup(db, site.business_id);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/sites/:id(\\d+)/members/:userId(\\d+)', authenticate, withActor, async (req, res, next) => {
  try {
    const site = await siteFor(req, res);
    if (!site) return;
    // Leaving a site keeps the person in the business (and the row is archived by trigger, migration 054).
    await db.query('DELETE FROM site_members WHERE site_id = $1 AND user_id = $2', [site.id, parseInt(req.params.userId, 10)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
