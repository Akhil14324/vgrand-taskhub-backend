const bcrypt = require('bcryptjs');
const { roleForOrgLevel } = require('../utils/org');
const { setMemberships, syncLeaderGroups, ensureBusinessGroup } = require('../services/org');

/**
 * The VGrand group's starting structure. Runs once (tracked in the migrations table
 * as SEED_MARKER); after that, everything is managed from the Organisation screen.
 * Change names/usernames here before the first deploy if needed.
 */
const SEED_MARKER = 'seed:organization-v1';

const BUSINESSES = [
  { name: 'VGrand Family Restaurant', type: 'restaurant', color: 'orange', aliases: ['vgrand family restaurant', 'vigrand family restaurant', 'v grand family restaurant', 'vgrand restaurant'] },
  { name: 'VGrand Infra', type: 'construction', color: 'blue', aliases: ['vgrand infra', 'vigrand infra', 'v grand infra', 'vgrand infrastructure'] },
  { name: 'VTech', type: 'it', color: 'purple', aliases: ['vtech', 'v tech', 'vgrand tech'] },
  { name: 'BVL Mines & Minerals', type: 'mines', color: 'amber', aliases: ['bvl mines and minerals', 'bvl mines & minerals', 'bvl rocks and minerals', 'bvl rocks & minerals', 'bvl'] },
];

const PEOPLE = [
  { name: 'T Vinod Kumar', username: 'vinod', orgLevel: 1 },
  { name: 'Kaushal', username: 'kaushal', orgLevel: 2, memberships: [{ business: 'VTech', designation: 'head' }] },
  { name: 'V Akhil', username: 'akhil', orgLevel: 3 },
  { name: 'N Varun Kumar', username: 'varun', orgLevel: 3 },
  { name: 'Chandrasekhar', username: 'chandrasekhar', memberships: [{ business: 'VGrand Family Restaurant', designation: 'head' }] },
  { name: 'Srinivas', username: 'srinivas', memberships: [{ business: 'BVL Mines & Minerals', designation: 'head' }] },
  { name: 'Nagarjuna', username: 'nagarjuna', memberships: [{ business: 'VGrand Infra', designation: 'head' }] },
  { name: 'Ashok Kumar', username: 'ashok', memberships: [{ business: 'VGrand Infra', designation: 'head' }] },
];

const ROLE_RANK = { user: 1, admin: 2, super_admin: 3 };

const normalize = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

async function seedOrganization(q, { log = console.log } = {}) {
  if (process.env.SEED_ORGANIZATION === 'false') return;
  const done = await q.query('SELECT 1 FROM migrations WHERE filename = $1', [SEED_MARKER]);
  if (done.rows.length) return;

  log('Seeding VGrand organisation...');
  const defaultPassword = process.env.SEED_DEFAULT_PASSWORD || 'Vgrand@2026';
  const hash = await bcrypt.hash(defaultPassword, 10);

  // Businesses: reuse an existing one when the name matches, otherwise create it.
  const existingBiz = await q.query('SELECT id, name FROM businesses');
  const businessIds = {};
  let order = 1;
  for (const biz of BUSINESSES) {
    const keys = new Set([biz.name, ...biz.aliases].map(normalize));
    const match = existingBiz.rows.find((b) => keys.has(normalize(b.name)));
    if (match) {
      await q.query('UPDATE businesses SET color = COALESCE(color, $1), sort_order = $2 WHERE id = $3', [biz.color, order, match.id]);
      businessIds[biz.name] = match.id;
    } else {
      const created = await q.query(
        `INSERT INTO businesses (name, type, description, color, sort_order) VALUES ($1, $2, '', $3, $4) RETURNING id`,
        [biz.name, biz.type, biz.color, order]
      );
      businessIds[biz.name] = created.rows[0].id;
      log(`  + business ${biz.name}`);
    }
    order += 1;
  }

  // People: place existing accounts with the same username, create the rest.
  for (const person of PEOPLE) {
    const role = roleForOrgLevel(person.orgLevel || null);
    const existing = await q.query('SELECT id, role FROM users WHERE LOWER(username) = LOWER($1)', [person.username]);
    let userId;
    let effectiveRole = role;
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      // Place the existing account but never downgrade the permissions it already has.
      if (ROLE_RANK[existing.rows[0].role] > ROLE_RANK[role]) effectiveRole = existing.rows[0].role;
      await q.query('UPDATE users SET org_level = $1, role = $2 WHERE id = $3', [person.orgLevel || null, effectiveRole, userId]);
      log(`  ~ placed existing account @${person.username}`);
    } else {
      const created = await q.query(
        `INSERT INTO users (name, username, password_hash, role, status, org_level, must_change_password)
         VALUES ($1, $2, $3, $4, 'active', $5, TRUE) RETURNING id`,
        [person.name, person.username, hash, role, person.orgLevel || null]
      );
      userId = created.rows[0].id;
      log(`  + @${person.username} (${person.name})`);
    }

    if (person.memberships?.length) {
      const current = await q.query('SELECT business_id, designation, title FROM user_businesses WHERE user_id = $1', [userId]);
      const wanted = person.memberships.map((m) => ({ business_id: businessIds[m.business], designation: m.designation }));
      const keep = current.rows.filter((c) => !wanted.some((w) => w.business_id === c.business_id));
      await setMemberships(q, userId, [...wanted, ...keep]);
    }
    if (effectiveRole !== 'user') await syncLeaderGroups(q, userId, effectiveRole);
  }

  for (const id of Object.values(businessIds)) await ensureBusinessGroup(q, id);

  await q.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [SEED_MARKER]);
  log(`  ✓ Organisation seeded. New accounts use the password "${defaultPassword}" and must change it on first login.`);
}

module.exports = { seedOrganization, BUSINESSES, PEOPLE };
