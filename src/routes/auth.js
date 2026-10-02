const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText, validatePassword } = require('../middleware/sanitize');
const { USERNAME_PATTERN } = require('../utils/mentions');
const { notify } = require('../utils/notify');
const {
  DESIGNATIONS,
  LEADERSHIP,
  loadActor,
  actorBestLevel,
  isLeader,
  isPortalAdmin,
  displayTitle,
  designationLevel,
  BUSINESS_MANAGER_LEVEL,
} = require('../utils/org');
const { actorCanMonitor } = require('../services/monitor');

const router = express.Router();

/** The signed-in user's profile plus their place in the hierarchy. */
async function sessionUser(userId) {
  const result = await db.query(
    `SELECT u.id, u.name, u.username, u.email, u.role, u.business_id, u.status, u.created_at,
            u.org_level, u.title, u.must_change_password, u.profile_picture,
            b.name AS business_name, b.type AS business_type,
            COALESCE((SELECT json_agg(json_build_object(
                'business_id', ub.business_id, 'business_name', bb.name, 'business_color', bb.color,
                'designation', ub.designation, 'title', ub.title) ORDER BY bb.sort_order, bb.name)
              FROM user_businesses ub JOIN businesses bb ON bb.id = ub.business_id
              WHERE ub.user_id = u.id), '[]') AS memberships
     FROM users u
     LEFT JOIN businesses b ON u.business_id = b.id
     WHERE u.id = $1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) return null;
  const actor = await loadActor(userId);
  user.memberships = user.memberships.map((m) => ({
    ...m,
    designation_label: DESIGNATIONS[m.designation]?.label || 'Member',
    level: designationLevel(m.designation),
  }));
  user.level = actorBestLevel(actor);
  user.tier = user.org_level && LEADERSHIP[user.org_level] ? LEADERSHIP[user.org_level].label : null;
  user.display_title = displayTitle(user, user.memberships[0]?.designation, user.memberships[0]?.title);
  user.is_leader = isLeader(actor);
  user.is_portal = isPortalAdmin(actor);
  // Leadership and business heads can watch the to-dos of the people below them (Team Monitor).
  user.can_monitor = actorCanMonitor(actor);
  user.manages_business_ids = user.memberships.filter((m) => m.level <= BUSINESS_MANAGER_LEVEL).map((m) => m.business_id);
  return user;
}

// POST /api/auth/signup
router.post('/signup', async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 100);
    const username = sanitizeText(req.body.username, 100);
    const { password } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Name, username, and password are required' });
    }
    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: 'Username can use letters, numbers, dot, dash or underscore (3–30 characters, no spaces)' });
    }
    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const existing = await db.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (name, username, password_hash, role, business_id, status)
       VALUES ($1, $2, $3, 'user', NULL, 'active')
       RETURNING id, name, username, role, business_id, status, created_at`,
      [name, username, hash]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, business_id: user.business_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Tell the people who can place newcomers in the organisation.
    const admins = await db.query(
      `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND status != 'inactive'`
    );
    await notify(admins.rows.map((a) => a.id), {
      type: 'user_joined',
      title: 'New person signed up',
      body: `${name} (@${username}) is waiting to be placed in a business.`,
      data: { userId: user.id },
    });

    res.status(201).json({ token, user: await sessionUser(user.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const loginField = sanitizeText(req.body.username || req.body.email, 255);
    const { password } = req.body;

    if (!loginField || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Try username first, then email (super_admin can login with email)
    let result = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [loginField]);
    if (result.rows.length === 0) {
      result = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND role = $2', [loginField, 'super_admin']);
    }
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (user.status === 'inactive') {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact your administrator.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, business_id: user.business_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({ token, user: await sessionUser(user.id) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/me — self-service account deletion (password confirmed)
router.delete('/me', authenticate, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required to delete your account' });
    }

    const userRes = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, userRes.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM users WHERE id = $1', [req.user.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      client.release();
      throw txErr;
    }
    client.release();

    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password — TEMPORARY: sets a new password for a username with no proof of
// identity (no old password, no email code), by the owner's choice until a real flow replaces it.
// Switch it off by setting OPEN_PASSWORD_RESET=false on the host. Limited to 5 tries per 15 minutes per IP.
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset attempts, please try again later.' },
});

router.post('/forgot-password', forgotLimiter, async (req, res, next) => {
  try {
    if (String(process.env.OPEN_PASSWORD_RESET || '').toLowerCase() === 'false') {
      return res.status(404).json({ error: 'Password reset is turned off. Ask an administrator.' });
    }
    const username = sanitizeText(req.body.username, 255);
    const { new_password } = req.body;
    if (!username || !new_password) {
      return res.status(400).json({ error: 'Username and new password are required' });
    }
    const passwordError = validatePassword(new_password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const found = await db.query('SELECT id, status FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'No account with that username' });
    if (found.rows[0].status === 'inactive') {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact your administrator.' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2',
      [hash, found.rows[0].id]
    );
    res.json({ message: 'Password updated. You can sign in now.' });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — get current user from token
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await sessionUser(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
