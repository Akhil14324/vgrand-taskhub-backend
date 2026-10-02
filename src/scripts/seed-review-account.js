/**
 * Seeds an Apple/Google review account with sample data so reviewers can
 * log in and exercise the app without needing a pre-existing organization.
 *
 * Idempotent: safe to run multiple times. Updates the password and re-seeds
 * sample tasks if the account already exists.
 *
 * Usage:
 *   node src/scripts/seed-review-account.js
 *
 * Review credentials (set via env or defaults below):
 *   REVIEW_USERNAME  (default: apple-review)
 *   REVIEW_PASSWORD   (default: Review1234)
 *   REVIEW_EMAIL      (default: apple-review@vgrand.com)
 */
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { directPool } = require('../db');

dotenv.config();

const REVIEW_USERNAME = process.env.REVIEW_USERNAME || 'apple-review';
const REVIEW_PASSWORD = process.env.REVIEW_PASSWORD || 'Review1234';
const REVIEW_EMAIL = process.env.REVIEW_EMAIL || 'apple-review@vgrand.com';
const REVIEW_NAME = 'App Review Demo';

async function seedReviewAccount() {
  console.log('=== TaskHub Review Account Seeder ===\n');
  const client = await directPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure a demo business exists.
    const bizRes = await client.query(
      `INSERT INTO businesses (name, type, description)
       VALUES ($1, 'it', 'Sample business used for App Store / Play Store review.')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ['VGrand Demo Business']
    );
    const businessId = bizRes.rows[0].id;

    // 2. Ensure an admin exists for the demo business (so the reviewer can see admin features too).
    const adminHash = await bcrypt.hash('Admin1234', 10);
    const adminRes = await client.query(
      `INSERT INTO users (name, email, username, password_hash, role, business_id, status)
       VALUES ('Demo Admin', 'demo-admin@vgrand.com', 'demo-admin', $1, 'admin', $2, 'active')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'
       RETURNING id`,
      [adminHash, businessId]
    );
    const adminId = adminRes.rows[0].id;

    // 3. Ensure the review (user role) account exists, assigned to the demo business.
    const userHash = await bcrypt.hash(REVIEW_PASSWORD, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, username, password_hash, role, business_id, status)
       VALUES ($1, $2, $3, $4, 'user', $5, 'active')
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             username = EXCLUDED.username,
             status = 'active',
             business_id = EXCLUDED.business_id
       RETURNING id`,
      [REVIEW_NAME, REVIEW_EMAIL, REVIEW_USERNAME, userHash, businessId]
    );
    const reviewUserId = userRes.rows[0].id;

    // 4. Link the review user to the demo business via user_businesses (if table exists).
    await client.query(
      `INSERT INTO user_businesses (user_id, business_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [reviewUserId, businessId]
    ).catch(() => { /* table may not exist; safe to ignore */ });

    // 5. Seed a few sample tasks assigned to the reviewer (idempotent by title).
    const sampleTasks = [
      { title: 'Review: Complete daily checklist', status: 'pending', due: 'tomorrow' },
      { title: 'Review: Submit weekly report', status: 'pending', due: '+7 days' },
      { title: 'Review: Onboard new team member', status: 'completed', due: '-2 days' },
    ];
    for (const task of sampleTasks) {
      const dueDate = task.due === 'tomorrow'
        ? new Date(Date.now() + 86400000)
        : task.due.startsWith('+')
          ? new Date(Date.now() + parseInt(task.due) * 86400000)
          : new Date(Date.now() - 86400000);
      const done = task.status === 'completed';
      const inserted = await client.query(
        `INSERT INTO todos (business_id, created_by, assignee_id, assigned_at, title, notes, status, is_done,
                            due_date, done_by, done_at)
         SELECT $1, $2, $3, NOW(), $4, $5, $6, $7, $8, CASE WHEN $7 THEN $2 END, CASE WHEN $7 THEN NOW() END
         WHERE NOT EXISTS (SELECT 1 FROM todos WHERE business_id = $1 AND title = $4)
         RETURNING id`,
        [businessId, adminId, reviewUserId, task.title, 'Sample task for App Review.', done ? 'done' : 'todo', done, dueDate]
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO todo_members (todo_id, user_id, added_by) VALUES ($1, $2, $3), ($1, $4, $3) ON CONFLICT DO NOTHING`,
          [inserted.rows[0].id, adminId, adminId, reviewUserId]
        );
      }
    }

    // 6. Seed a welcome notification.
    await client.query(
      `INSERT INTO notifications (user_id, type, message)
       VALUES ($1, 'assignment', 'Welcome! This is a demo account for App Store / Play Store review.')
       ON CONFLICT DO NOTHING`,
      [reviewUserId]
    );

    await client.query('COMMIT');

    console.log('Review account ready.\n');
    console.log('  Username: ' + REVIEW_USERNAME);
    console.log('  Email:    ' + REVIEW_EMAIL);
    console.log('  Password: ' + REVIEW_PASSWORD);
    console.log('  Role:     user (assigned to VGrand Demo Business)');
    console.log('');
    console.log('Admin account (to review admin features):');
    console.log('  Username: demo-admin');
    console.log('  Email:    demo-admin@vgrand.com');
    console.log('  Password: Admin1234');
    console.log('  Role:     admin');
    console.log('\n=== Done ===');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error seeding review account:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await directPool.end();
  }
}

seedReviewAccount();
