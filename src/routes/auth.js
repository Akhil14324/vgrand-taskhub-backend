const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { sanitizeText, validatePassword } = require('../middleware/sanitize');

const router = express.Router();

// POST /api/auth/signup
router.post('/signup', async (req, res, next) => {
  try {
    const name = sanitizeText(req.body.name, 100);
    const username = sanitizeText(req.body.username, 100);
    const { password } = req.body;

    if (!name || !username || !password) {
      return res.status(400).json({ error: 'Name, username, and password are required' });
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

    // Notify all admins and super_admins about the new user
    const admins = await db.query(
      `SELECT id FROM users WHERE role IN ('admin', 'super_admin')`
    );
    for (const admin of admins.rows) {
      await db.query(
        `INSERT INTO notifications (user_id, type, message)
         VALUES ($1, 'user_joined', $2)`,
        [admin.id, `New user joined: ${name} (${username})`]
      );
    }

    res.status(201).json({ token, user });
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

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, business_id: user.business_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        business_id: user.business_id,
        status: user.status,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me — get current user from token
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.username, u.email, u.role, u.business_id, u.status, u.created_at,
              b.name AS business_name, b.type AS business_type
       FROM users u
       LEFT JOIN businesses b ON u.business_id = b.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
