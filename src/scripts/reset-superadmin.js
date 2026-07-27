const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { directPool } = require('../db');

dotenv.config();

async function resetSuperadmin() {
  const adminEmail = 'admin@taskhub.com';
  const adminUsername = 'Superadmin';
  const newPassword = 'Admin123';

  console.log('=== Superadmin Diagnostic & Reset ===\n');

  try {
    const check = await directPool.query(
      'SELECT id, name, username, email, role, status FROM users WHERE email = $1 OR username = $2',
      [adminEmail, adminUsername]
    );

    if (check.rows.length === 0) {
      console.log('✗ Superadmin user NOT found in database.');
      console.log('  Creating Superadmin user...');
      const hash = await bcrypt.hash(newPassword, 10);
      await directPool.query(
        `INSERT INTO users (name, email, username, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'super_admin', 'active')`,
        ['Super Admin', adminEmail, adminUsername, hash]
      );
      console.log(`  ✓ Superadmin created successfully.`);
      console.log(`    Username: ${adminUsername}`);
      console.log(`    Email: ${adminEmail}`);
      console.log(`    Password: ${newPassword}`);
    } else {
      const user = check.rows[0];
      console.log('✓ Superadmin user found:');
      console.log(`    ID: ${user.id}`);
      console.log(`    Name: ${user.name}`);
      console.log(`    Username: ${user.username}`);
      console.log(`    Email: ${user.email}`);
      console.log(`    Role: ${user.role}`);
      console.log(`    Status: ${user.status}`);

      if (user.role !== 'super_admin') {
        console.log('  ⚠ Role is not super_admin! Fixing...');
      }

      console.log('  Resetting password...');
      const hash = await bcrypt.hash(newPassword, 10);
      await directPool.query(
        `UPDATE users SET password_hash = $1, role = 'super_admin', username = $2, status = 'active', updated_at = NOW()
         WHERE id = $3`,
        [hash, adminUsername, user.id]
      );
      console.log('  ✓ Password reset successfully.');
      console.log(`    Username: ${adminUsername}`);
      console.log(`    Email: ${adminEmail}`);
      console.log(`    Password: ${newPassword}`);
    }

    console.log('\n=== Done ===');
    console.log('You can now login with:');
    console.log(`  Username: ${adminUsername} (or email: ${adminEmail})`);
    console.log(`  Password: ${newPassword}`);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await directPool.end();
  }
}

resetSuperadmin();
