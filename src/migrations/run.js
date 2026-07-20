const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');

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
  const existing = await directQuery('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await directQuery(
      `INSERT INTO users (name, email, password_hash, role, status)
       VALUES ($1, $2, $3, 'super_admin', 'active')`,
      ['Super Admin', adminEmail, hash]
    );
    console.log('  ✓ Admin user created (admin@taskhub.com / admin123)');
  } else {
    await directQuery(
      `UPDATE users SET role = 'super_admin' WHERE email = $1 AND role != 'super_admin'`,
      [adminEmail]
    );
    console.log('  ✓ Admin user already exists (upgraded to super_admin if needed)');
  }

  if (autoClose) {
    await db.directPool.end();
    console.log('\nAll migrations complete.');
  } else {
    console.log('Migrations applied, keeping pool open for app server.');
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
