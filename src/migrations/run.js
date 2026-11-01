const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { seedOrganization, seedOwner } = require('../seed/organization');
const { seedStructure } = require('../seed/structure');
const { backfillBoards } = require('../services/boards');

async function ensureMigrationsTable(directQuery) {
  await directQuery(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function runMigrations({ autoClose = true } = {}) {
  const migrationsDir = __dirname;
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Use direct (non-pooled) connection for migrations
  // PgBouncer transaction mode doesn't support DDL like CREATE FUNCTION / CREATE TRIGGER
  const directQuery = (text, params) => db.directPool.query(text, params);

  await ensureMigrationsTable(directQuery);

  const appliedResult = await directQuery('SELECT filename FROM migrations');
  const applied = new Set(appliedResult.rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping already applied migration: ${file}`);
      continue;
    }
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`Running migration: ${file}`);
    try {
      await directQuery(sql);
      await directQuery('INSERT INTO migrations (filename) VALUES ($1)', [file]);
      console.log(`  ✓ ${file} executed successfully`);
    } catch (err) {
      console.error(`  ✗ ${file} failed:`, err.message);
      throw err;
    }
  }

  // Seed admin user with properly hashed password
  console.log('Seeding admin user...');
  const adminEmail = 'admin@taskhub.com';
  const adminUsername = 'Superadmin';
  const existing = await directQuery('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await directQuery(
      `INSERT INTO users (name, email, username, password_hash, role, status)
       VALUES ($1, $2, $3, $4, 'super_admin', 'active')`,
      ['Super Admin', adminEmail, adminUsername, hash]
    );
    console.log('  ✓ Admin user created (Superadmin / admin123)');
  } else {
    await directQuery(
      `UPDATE users SET role = 'super_admin', username = $2 WHERE email = $1 AND (role != 'super_admin' OR username != $2)`,
      [adminEmail, adminUsername]
    );
    console.log('  ✓ Admin user already exists (upgraded to super_admin and username set to Superadmin if needed)');
  }

  await seedOrganization({ query: directQuery });
  await seedOwner({ query: directQuery });
  await seedStructure({ query: directQuery });
  // Every business has its default board and every board its default columns (migration 055).
  await backfillBoards({ query: directQuery });

  if (autoClose) {
    await db.directPool.end();
    console.log('\nAll migrations complete.');
  } else {
    console.log('Migrations applied, keeping pool open for app server.');
  }
}

// Files in this folder that the database has not applied yet (read-only check).
async function pendingMigrations() {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.sql')).sort();
  const directQuery = (text, params) => db.directPool.query(text, params);
  await ensureMigrationsTable(directQuery);
  const applied = new Set((await directQuery('SELECT filename FROM migrations')).rows.map((r) => r.filename));
  return files.filter((f) => !applied.has(f));
}

const LOCK_KEY = 727001; // pg advisory lock: two instances starting together must not apply the same file twice

/**
 * Applies the SQL files the database has not seen yet, in order, and nothing else (no seeds, no backfill).
 * Safe on every boot: applied files are skipped, a lock keeps two starting instances from racing, and each file
 * runs as one statement batch, so a failing file changes nothing. Used when MIGRATIONS_AUTO=false so a deploy
 * brings its own schema; `dir` is injectable for tests. Returns the file names it applied.
 */
async function applyPendingMigrations({ dir = __dirname, log = console.log } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await db.directPool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureMigrationsTable((text, params) => client.query(text, params));
    const done = new Set((await client.query('SELECT filename FROM migrations')).rows.map((r) => r.filename));
    for (const file of files) {
      if (done.has(file)) continue;
      log(`Applying migration: ${file}`);
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        applied.push(file);
        log(`  ✓ ${file}`);
      } catch (err) {
        log(`  ✗ ${file} failed: ${err.message}`);
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations, pendingMigrations, applyPendingMigrations };

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
