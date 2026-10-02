const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const businessRoutes = require('./routes/businesses');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const chatRoutes = require('./routes/chat');
const todoRoutes = require('./routes/todos');
const todoTimelineRoutes = require('./routes/todoTimeline');
const monitorRoutes = require('./routes/monitor');
const orgRoutes = require('./routes/org');
const approvalRoutes = require('./routes/approvals');
const db = require('./db');
const { runMigrations } = require('./migrations/run');
const { scheduleOverdueNotifications } = require('./jobs/overdueNotifications');
const { scheduleTodoReminders } = require('./jobs/todoReminders');
const { scheduleNudges } = require('./jobs/nudges');
const engageRoutes = require('./routes/engage');
const templateRoutes = require('./routes/templates');
const insightRoutes = require('./routes/insights');
const goalRoutes = require('./routes/goals');
const collabRoutes = require('./routes/collab');
const standupRoutes = require('./routes/standup');
const { setIO } = require('./utils/notify');
const { setupSocketIO } = require('./socket');
const { requestId } = require('./middleware/requestId');
const { waitForConnection } = db;

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET === 'change-this-to-a-strong-secret-key') {
  console.error('[startup] FATAL: JWT_SECRET must be set to a strong secret of at least 32 characters.');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    console.warn('[startup] WARNING: Running with weak JWT_SECRET in development. Fix this before production!');
  }
}

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''));
const allowAllOrigins = allowedOrigins.includes('*');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
  hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(compression());
app.use(requestId);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowAllOrigins || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' && req.path === '/me',
  message: { error: 'Too many authentication attempts, please try again later.' },
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests, please try again later.' },
});

app.use('/api', globalLimiter);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use('/legal', express.static(PUBLIC_DIR));
app.get('/privacy', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'terms.html')));
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TaskHub</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827;margin:0;padding:48px 16px;text-align:center}h1{color:#4f46e5}p{color:#6b7280}a{color:#4f46e5;margin:0 8px}</style></head><body><h1>TaskHub API</h1><p>Multi-Business Task Monitoring backend.</p><p><a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p></body></html>`);
});

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
app.use('/api/notifications', notificationRoutes);
app.use('/api/chat', chatLimiter, chatRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/todos', todoTimelineRoutes);
app.use('/api/monitor', monitorRoutes);
app.use('/api/engage', engageRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/collab', collabRoutes);
app.use('/api/standup', standupRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/approvals', approvalRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] [${req.id || '-'}] Error:`, err.message);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowAllOrigins ? true : allowedOrigins,
    credentials: true,
  },
});

app.set('io', io);
setIO(io);
setupSocketIO(io);

if (require.main === module) {
  (async () => {
    try {
      await waitForConnection();
      await runMigrations({ autoClose: false });
      server.listen(PORT, () => {
        console.log(`TaskHub backend running on port ${PORT}`);
      });
      scheduleOverdueNotifications();
      scheduleTodoReminders();
      scheduleNudges();
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  })();
} else {
  module.exports = { app, server, io };
}
