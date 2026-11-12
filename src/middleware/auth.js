const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const db = require('../db');
const { runAsActor } = require('../utils/actorContext');

dotenv.config();

const USER_TTL_MS = 5000;
const userCache = new Map(); // id -> { id, role, status, at }

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch the user's current role from the database to ensure
    // role changes (promote/demote) take effect without re-login
    // Kept for a few seconds: the app fires many requests in a burst, and each used to cost a database
    // round trip here. A role change or deactivation still takes effect within USER_TTL_MS.
    let dbUser = userCache.get(decoded.id);
    if (!dbUser || dbUser.at < Date.now() - USER_TTL_MS) {
      const result = await db.query(
        'SELECT id, role, status FROM users WHERE id = $1',
        [decoded.id]
      );
      if (result.rows.length === 0) {
        userCache.delete(decoded.id);
        return res.status(401).json({ error: 'User no longer exists' });
      }
      dbUser = { ...result.rows[0], at: Date.now() };
      userCache.set(decoded.id, dbUser);
      if (userCache.size > 2000) userCache.delete(userCache.keys().next().value);
    }
    if (dbUser.status === 'inactive') {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    req.user = {
      ...decoded,
      id: dbUser.id,
      role: dbUser.role,
    };
    runAsActor(dbUser.id, next);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = { authenticate, requireAdmin, requireSuperAdmin };
