const bcrypt = require('bcryptjs');
const { roleForOrgLevel } = require('../utils/org');
const { setMemberships, syncLeaderGroups, ensureBusinessGroup } = require('../services/org');

/**
 * The VGrand group's starting structure. Runs once (tracked in the migrations table
 * as SEED_MARKER); after that, everything is managed from the Organisation screen.
 * Change names/usernames here before the first deploy if needed.
 */
const SEED_MARKER = 'seed:organization-v1';
// Second pass: the business accountants. Separate marker so deployments that already
// ran v1 still pick these up on their next start.
const ACCOUNTANTS_MARKER = 'seed:organization-v2-accountants';

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

// Accountants per business. "Accountant Infra" is a placeholder name: rename it from the
// Organisation screen once the real person is known.
const ACCOUNTANTS = [
  { name: 'Vasavi', username: 'vasavi', memberships: [{ business: 'VGrand Family Restaurant', designation: 'accountant' }] },
  { name: 'Accountant Infra', username: 'infra.accountant', memberships: [{ business: 'VGrand Infra', designation: 'accountant' }] },
  { name: 'Shafi', username: 'shafi', memberships: [{ business: 'BVL Mines & Minerals', designation: 'accountant' }] },
  { name: 'Prudvi', username: 'prudvi', memberships: [{ business: 'BVL Mines & Minerals', designation: 'accountant' }] },
];

const ROLE_RANK = { user: 1, admin: 2, super_admin: 3 };

const normalize = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

/** Reuse an existing business when the name matches, otherwise create it. */
async function ensureBusinesses(q, log) {
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
  return businessIds;
}

/** Place existing accounts with the same username, create the rest. */
async function placePeople(q, people, businessIds, hash, log) {
  for (const person of people) {
    const role = roleForOrgLevel(person.orgLevel || null);
    const existing = await q.query('SELECT id, role FROM users WHERE LOWER(username) = LOWER($1)', [person.username]);
    let userId;
    let effectiveRole = role;
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      // Place the existing account but never downgrade the permissions it already has.
      if (ROLE_RANK[existing.rows[0].role] > ROLE_RANK[role]) effectiveRole = existing.rows[0].role;
      if (person.orgLevel) {
        await q.query('UPDATE users SET org_level = $1, role = $2 WHERE id = $3', [person.orgLevel, effectiveRole, userId]);
      }
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
}

async function seedOrganization(q, { log = console.log } = {}) {
  if (process.env.SEED_ORGANIZATION === 'false') return;
  const defaultPassword = process.env.SEED_DEFAULT_PASSWORD || 'Vgrand@2026';

  const done = await q.query('SELECT filename FROM migrations WHERE filename = ANY($1)', [[SEED_MARKER, ACCOUNTANTS_MARKER]]);
  const ran = new Set(done.rows.map((r) => r.filename));
  if (ran.has(SEED_MARKER) && ran.has(ACCOUNTANTS_MARKER)) return;

  const hash = await bcrypt.hash(defaultPassword, 10);
  const businessIds = await ensureBusinesses(q, log);

  if (!ran.has(SEED_MARKER)) {
    log('Seeding VGrand organisation...');
    await placePeople(q, PEOPLE, businessIds, hash, log);
    await q.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [SEED_MARKER]);
    log(`  ✓ Organisation seeded. New accounts use the password "${defaultPassword}" and must change it on first login.`);
  }

  if (!ran.has(ACCOUNTANTS_MARKER)) {
    log('Seeding business accountants...');
    await placePeople(q, ACCOUNTANTS, businessIds, hash, log);
    await q.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [ACCOUNTANTS_MARKER]);
    log('  ✓ Accountants seeded.');
  }

  for (const id of Object.values(businessIds)) await ensureBusinessGroup(q, id);
}

const OWNER_MARKER = 'seed:owner-account-v1';
const OWNER_USERNAME = 'owner';

/**
 * The owner login: a super admin with no place in the chain of command (level 0). It sees every to-do
 * and every chat, and it can switch any module on or off for anyone. Created once; after that the
 * password is the owner's to change, so a restart never resets it.
 */
async function seedOwner(q, { log = console.log } = {}) {
  const done = await q.query('SELECT 1 FROM migrations WHERE filename = $1', [OWNER_MARKER]);
  if (done.rows.length) return;
  const password = process.env.OWNER_PASSWORD || 'Vgrand@2026';
  const hash = await bcrypt.hash(password, 10);
  const existing = await q.query('SELECT id FROM users WHERE LOWER(username) = $1', [OWNER_USERNAME]);
  let userId;
  if (existing.rows.length) {
    userId = existing.rows[0].id;
    await q.query(
      `UPDATE users SET role = 'super_admin', org_level = NULL, status = 'active', password_hash = $2,
              must_change_password = FALSE, updated_at = NOW() WHERE id = $1`,
      [userId, hash]
    );
  } else {
    const created = await q.query(
      `INSERT INTO users (name, username, password_hash, role, status, org_level, must_change_password)
       VALUES ('Owner', $1, $2, 'super_admin', 'active', NULL, FALSE) RETURNING id`,
      [OWNER_USERNAME, hash]
    );
    userId = created.rows[0].id;
  }
  await syncLeaderGroups(q, userId, 'super_admin');
  await q.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER_MARKER]);
  log(`  ✓ Owner login ready: "${OWNER_USERNAME}"`);
}

module.exports = { seedOrganization, seedOwner, BUSINESSES, PEOPLE, ACCOUNTANTS };
