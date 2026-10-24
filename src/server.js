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
const todoStepRoutes = require('./routes/todoSteps');
const aiRoutes = require('./routes/ai');
const meetingNoteRoutes = require('./routes/meetingNotes');
const planRoutes = require('./routes/plan');
const workflowRoutes = require('./routes/workflows');
const assistantRoutes = require('./routes/assistant');
const reportRoutes = require('./routes/reports');
const monitorRoutes = require('./routes/monitor');
const orgRoutes = require('./routes/org');
const approvalRoutes = require('./routes/approvals');
const accessRoutes = require('./routes/access');
const erpRoutes = require('./routes/erp');
const db = require('./db');
const { runMigrations } = require('./migrations/run');
const { scheduleOverdueNotifications } = require('./jobs/overdueNotifications');
const { scheduleTodoReminders } = require('./jobs/todoReminders');
const { scheduleNudges } = require('./jobs/nudges');
const { scheduleRoast } = require('./jobs/roast');
const { scheduleChatRetention } = require('./jobs/chatRetention');
const { scheduleChasing } = require('./jobs/chasing');
const { scheduleWorkflows } = require('./jobs/workflows');
const { scheduleRisk } = require('./jobs/risk');
const { scheduleDailyBrief } = require('./jobs/dailyBrief');
const { scheduleErpApprovals } = require('./jobs/erpApprovals');
const engageRoutes = require('./routes/engage');
const templateRoutes = require('./routes/templates');
const insightRoutes = require('./routes/insights');
const goalRoutes = require('./routes/goals');
const collabRoutes = require('./routes/collab');
const standupRoutes = require('./routes/standup');
const claudeRoutes = require('./routes/claude');
const automationRoutes = require('./routes/automation');
const automationEngine = require('./services/automation/engine');
const { isInternal, chainFromRequest } = require('./services/automation/internalApi');
const { als } = require('./utils/automation/bus');
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

// The raw body is kept for the signed /api/claude/callback and /api/erp/webhook.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Signed-in people are counted per person, not per IP: a whole office shares one address, and the app
// itself makes many calls (lists, notifications, chat), so a shared IP bucket ran out and blocked sign-in.
const jwtLib = require('jsonwebtoken');
const callerId = (req) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try { return jwtLib.verify(h.split(' ')[1], process.env.JWT_SECRET).id; } catch { return null; }
};
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (callerId(req) ? 1500 : 600),
  keyGenerator: (req) => { const id = callerId(req); return id ? `u:${id}` : req.ip; },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isInternal(req),
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Only failed attempts count: a whole office sharing one IP signing in must not lock each other out.
  skipSuccessfulRequests: true,
  skip: (req) => (req.method === 'GET' && req.path === '/me') || isInternal(req),
  message: { error: 'Too many authentication attempts, please try again later.' },
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isInternal(req),
  message: { error: 'Too many chat requests, please try again later.' },
});

// Calls an automation makes to this same server keep the chain of automations that led to them, so what
// they cause cannot set the same automation off again.
app.use('/api', (req, res, next) => {
  const chain = isInternal(req) ? chainFromRequest(req) : null;
  if (chain) als.run(chain, next); else next();
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
app.use('/api/todos', todoStepRoutes);
app.use('/api/quick', todoStepRoutes.quick);
app.use('/api/meeting-notes', rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again in a few minutes.' } }), meetingNoteRoutes);
app.use('/api/ai', rateLimit({ windowMs: 15 * 60 * 1000, max: 150, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many AI requests. Try again in a few minutes.' } }), aiRoutes);
app.use('/api/plan', planRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/assistant', rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests to the assistant. Try again in a few minutes.' } }), assistantRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/monitor', monitorRoutes);
app.use('/api/engage', engageRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/collab', collabRoutes);
app.use('/api/standup', standupRoutes);
app.use('/api/claude', claudeRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/erp', erpRoutes);

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
      scheduleRoast();
      scheduleChatRetention();
      scheduleChasing();
      scheduleWorkflows();
      scheduleRisk();
      scheduleDailyBrief();
      scheduleErpApprovals();
      automationEngine.start();
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  })();
} else {
  module.exports = { app, server, io };
}
