const express  = require('express');
const mongoose = require('mongoose');
const helmet   = require('helmet');
const morgan   = require('morgan');
require('dotenv').config();

// ─── Crash guards ─────────────────────────────────────────────────────────────
// A single uncaught error (e.g. an IMAP socket 'error' event with no listener,
// or a stray rejected promise) must NOT be able to take the whole API down for
// every user. Log it loudly so it appears in the host logs, and keep serving.
// This also turns silent process deaths into a readable stack trace you can act
// on. (A truly fatal state will still surface; the host can restart if needed.)
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

const routes = require('./routes/Index');

const {
  admsHandshake,
  getRequest,
  admsReceiver,
} = require('./controllers/EsslController');

const app = express();

// ─── CORS (explicit, proxy-proof) ─────────────────────────────────────────────
// Registered FIRST so the OPTIONS preflight is answered before helmet / routes
// ever run. Reflects the request Origin when it's on the allow-list, echoes the
// requested headers, and short-circuits preflight with a 204. Set CORS_ORIGINS
// in the environment (comma-separated) to add/override allowed origins; use "*"
// to allow any origin (note: "*" cannot be combined with credentials per spec).
const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ||
  'https://skyupprojectmanagement.com,https://www.skyupprojectmanagement.com'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAny = ALLOWED_ORIGINS.includes('*');

  if (origin && (allowAny || ALLOWED_ORIGINS.includes(origin))) {
    // Reflect the specific origin (required when credentials are used).
    res.header('Access-Control-Allow-Origin', allowAny ? '*' : origin);
    res.header('Vary', 'Origin');
    if (!allowAny) res.header('Access-Control-Allow-Credentials', 'true');
    res.header(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    // Echo whatever headers the browser asked for (falls back to the usual set).
    res.header(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
        'Authorization,Content-Type',
    );
    res.header('Access-Control-Max-Age', '86400');
  }

  // Answer the preflight immediately — nothing downstream needs to run.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────
// crossOriginResourcePolicy is disabled so helmet's default
// "Cross-Origin-Resource-Policy: same-origin" doesn't interfere with the API
// being consumed from the separate frontend origin.
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ─── eSSL ADMS plain-text body parser ────────────────────────────────────────
// The device POSTs attendance logs as plain text, not JSON.
// Must be registered before routes so req.body is available.
// NOTE: the device firmware (iClock Proxy) calls the ".aspx" variants, so we
// register the text parser for those paths too.
app.use('/iclock/cdata',          express.text({ type: '*/*' }));
app.use('/iclock/cdata.aspx',     express.text({ type: '*/*' }));
app.use('/api/essl/iclock/cdata', express.text({ type: '*/*' }));

// ─── eSSL ADMS Device Routes (ROOT level — device cannot use /api prefix) ────
// These are called directly by the eSSL hardware, not by your frontend.
// The device always calls /iclock/cdata — this path is hardcoded in firmware.
app.get('/iclock/cdata',      admsHandshake);  // Device registration / clock sync
app.post('/iclock/cdata',     admsReceiver);   // Device pushes attendance punch logs
app.get('/iclock/getrequest', getRequest);     // Device polling for server commands

// Same handlers for the ".aspx" paths the device firmware actually calls
// (seen in logs as POST /iclock/cdata.aspx?...&table=ATTLOG|OPERLOG).
app.get('/iclock/cdata.aspx',      admsHandshake);
app.post('/iclock/cdata.aspx',     admsReceiver);
app.get('/iclock/getrequest.aspx', getRequest);

const path = require('path');
app.use('/uploads', require('./middleware/authMiddleware').protect, express.static(path.join(__dirname, 'uploads')));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is running', environment: process.env.NODE_ENV || 'development' });
});

// ─── Keep-alive (prevents Render free tier cold starts) ───────────────────────
// Point UptimeRobot or any cron service at GET /ping every 5 minutes.
app.get('/ping', (req, res) => res.send('pong'));

// ─── Seed Admin ───────────────────────────────────────────────────────────────
app.get('/seed-admin', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const User   = require('./models/users');
    const existing = await User.findOne({ email: 'admin@company.com' });
    if (existing) return res.json({ message: 'Admin already exists' });
    const password = await bcrypt.hash('admin123', await bcrypt.genSalt(10));
    await User.create({ name: 'Admin', email: 'admin@company.com', password, role: 'admin', status: 'active', department: 'Administration', designation: 'System Administrator' });
    res.json({ message: '✅ Admin created! Email: admin@company.com / Password: admin123' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── API Routes ───────────────────────────────────────────────────────────────
// FIX: excelTemplateRoutes must be mounted BEFORE app.use('/api', routes)
// because the catch-all /api router would intercept the request first
// and return 404 before excelTemplateRoutes ever gets a chance to handle it.
app.use('/api/excel-template', require('./routes/Exceltemplateroutes'));
app.use('/api', routes);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error' : err.message || 'Internal server error';
  res.status(statusCode).json({ success: false, message });
});

// ─── Database + Server Startup ────────────────────────────────────────────────
const PORT      = process.env.PORT      || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/project-management';

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('Database connected!');
    require('./services/workflowHandlers');
    const { initCronJobs } = require('./services/Cronscheduler');
    initCronJobs();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });