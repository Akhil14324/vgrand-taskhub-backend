const { ensureBusinessGroup } = require('../services/org');

/**
 * Vgrand's sites and the extra roles people hold (see MONDAY_COMPANY_CONTEXT.md). Runs once, tracked as
 * STRUCTURE_MARKER. It only adds: a missing business, sites, memberships. Existing rows are never changed,
 * and anyone or anything that doesn't exist on this database is skipped.
 *
 * Unlike seedOrganization this is not switched off by SEED_ORGANIZATION=false: it creates no accounts.
 */
const STRUCTURE_MARKER = 'seed:org-structure-v1';

// Businesses are found by name pattern because their stored names vary ("Vgrand HealthCare Pvt Ltd.").
const FIND = {
  restaurant: "name ILIKE '%family restaurant%'",
  infra: "name ILIKE '%infra%'",
  vtech: "name ILIKE 'vtech' OR name ILIKE 'v tech%'",
  bvl: "name ILIKE 'bvl%'",
  healthcare: "name ILIKE '%health%'",
  lounge: "name ILIKE '%lounge%'",
};

const NEW_BUSINESSES = [
  { key: 'lounge', name: 'Vgrand Lounge', type: 'bar', sector: 'liquor', color: 'pink' },
];

const SITES = [
  { business: 'restaurant', name: 'Ongolu', kind: 'branch', status: 'active' },
  { business: 'restaurant', name: 'Kandukuru', kind: 'branch', status: 'active' },
  { business: 'infra', name: 'Elite Homes', kind: 'project', status: 'completed' },
  { business: 'infra', name: 'Tripura', kind: 'project', status: 'under_construction' },
  { business: 'infra', name: 'Gateway', kind: 'project', status: 'upcoming' },
];

const MEMBERSHIPS = [
  { username: 'ashok', business: 'healthcare', designation: 'head' },
  { username: 'varun', business: 'restaurant', designation: 'head' },
  { username: 'varun', business: 'vtech', designation: 'member' },
  { username: 'akhil', business: 'vtech', designation: 'member' },
  { username: 'chandrasekhar', business: 'lounge', designation: 'head' },
];

const SITE_MEMBERS = [
  { username: 'chandrasekhar', business: 'restaurant', site: 'Ongolu', designation: 'head' },
  { username: 'varun', business: 'restaurant', site: 'Kandukuru', designation: 'head' },
  { username: 'nagarjuna', business: 'infra', site: 'Elite Homes', designation: 'head' },
  { username: 'nagarjuna', business: 'infra', site: 'Tripura', designation: 'head' },
  { username: 'nagarjuna', business: 'infra', site: 'Gateway', designation: 'head' },
];

async function findBusiness(q, key) {
  const r = await q.query(`SELECT id FROM businesses WHERE ${FIND[key]} ORDER BY id LIMIT 1`);
  return r.rows[0]?.id || null;
}

async function findUser(q, username) {
  const r = await q.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  return r.rows[0]?.id || null;
}

async function seedStructure(q, { log = console.log } = {}) {
  const done = await q.query('SELECT 1 FROM migrations WHERE filename = $1', [STRUCTURE_MARKER]);
  if (done.rows.length) return;
  // Only on a database that has the organisation (a blank test database has nothing to place).
  if (!(await findBusiness(q, 'restaurant'))) return;
  log('Placing Vgrand sites and roles...');

  const touched = new Set();
  for (const b of NEW_BUSINESSES) {
    if (await findBusiness(q, b.key)) continue;
    const order = (await q.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM businesses')).rows[0].n;
    const created = await q.query(
      `INSERT INTO businesses (name, type, description, color, sort_order, sector, group_id)
       VALUES ($1, $2, '', $3, $4, $5, (SELECT MIN(id) FROM org_groups)) RETURNING id`,
      [b.name, b.type, b.color, order, b.sector]
    );
    touched.add(created.rows[0].id);
    log(`  + business ${b.name}`);
  }

  const siteIds = {};
  for (const [i, s] of SITES.entries()) {
    const businessId = await findBusiness(q, s.business);
    if (!businessId) continue;
    const r = await q.query(
      `INSERT INTO sites (business_id, name, kind, status, sort_order) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, name) DO NOTHING RETURNING id`,
      [businessId, s.name, s.kind, s.status, i + 1]
    );
    const id = r.rows[0]?.id
      || (await q.query('SELECT id FROM sites WHERE business_id = $1 AND name = $2', [businessId, s.name])).rows[0].id;
    siteIds[`${s.business}/${s.name}`] = { id, businessId };
    if (r.rows.length) log(`  + site ${s.name}`);
  }

  const addMembership = async (userId, businessId, designation) => {
    const r = await q.query(
      `INSERT INTO user_businesses (user_id, business_id, designation) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, business_id) DO NOTHING RETURNING id`,
      [userId, businessId, designation]
    );
    if (r.rows.length) touched.add(businessId);
  };

  for (const m of MEMBERSHIPS) {
    const userId = await findUser(q, m.username);
    const businessId = await findBusiness(q, m.business);
    if (!userId || !businessId) continue;
    await addMembership(userId, businessId, m.designation);
  }

  for (const m of SITE_MEMBERS) {
    const userId = await findUser(q, m.username);
    const site = siteIds[`${m.business}/${m.site}`];
    if (!userId || !site) continue;
    await q.query(
      `INSERT INTO site_members (site_id, user_id, designation) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [site.id, userId, m.designation]
    );
    // Someone at a site is in its business too (a site head is a member there unless they hold more).
    await addMembership(userId, site.businessId, 'member');
  }

  // New business members join that business's chat group (adds missing participants only).
  for (const id of touched) await ensureBusinessGroup(q, id);

  await q.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [STRUCTURE_MARKER]);
  log('  ✓ Sites and roles placed.');
}

module.exports = { seedStructure, STRUCTURE_MARKER, SITES, MEMBERSHIPS, SITE_MEMBERS };
