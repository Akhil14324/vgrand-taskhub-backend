const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const businessRoutes = require('./routes/businesses');
const userRoutes = require('./routes/users');
const taskRoutes = require('./routes/tasks');
const notificationRoutes = require('./routes/notifications');
const db = require('./db');
const { runMigrations } = require('./migrations/run');
const { scheduleOverdueNotifications } = require('./jobs/overdueNotifications');

dotenv.config();

const app = express();

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''));

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

app.use(compression());

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

app.use('/api', globalLimiter);

app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: result.rows.length > 0 ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      database: 'error',
      error: 'Database connection failed',
    });
  }
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/users', userRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/notifications', notificationRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  (async () => {
    try {
      await runMigrations({ autoClose: false });
      app.listen(PORT, () => {
        console.log(`TaskHub backend running on port ${PORT}`);
      });
      scheduleOverdueNotifications();
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  })();
} else {
  module.exports = app;
}
