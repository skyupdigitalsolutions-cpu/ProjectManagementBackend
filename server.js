const express  = require('express');
const mongoose = require('mongoose');
const helmet   = require('helmet');
const morgan   = require('morgan');
require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
// Before the server is listening, an error means it CANNOT start (for example a
// missing file). Exit so the process manager shows the crash and restarts it,
// instead of a silent process that answers nothing (the proxy then returns 502).
let serverStarted = false;
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  if (!serverStarted) {
    console.error('Server could not start. Fix the error above (run: node scripts/checkDeploy.js).');
    process.exit(1);
  }
});

const routes = require('./routes/Index');

const {
  admsHandshake,
  getRequest,
  admsReceiver,
  deviceCmd,
  unknownDeviceCall,
} = require('./controllers/EsslController');

const app = express();

app.use((req, res, next) => {
  const qIndex = req.url.indexOf('?');
  const pathname = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
  const query = qIndex === -1 ? '' : req.url.slice(qIndex);
  const normalised = pathname.replace(/\/{2,}/g, '/');
  if (normalised !== pathname) {
    console.log(`[path-fix] ${pathname} → ${normalised}`);
    req.url = normalised + query;
  }
  next();
});

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ||
  'https://skyupprojectmanagement.com,https://www.skyupprojectmanagement.com,http://localhost:3000,http://127.0.0.1:3000,https://attendance-app.skyupdigitalsolutions.workers.dev'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAny = ALLOWED_ORIGINS.includes('*');
  if (origin && (allowAny || ALLOWED_ORIGINS.includes(origin))) {
    res.header('Access-Control-Allow-Origin', allowAny ? '*' : origin);
    res.header('Vary', 'Origin');
    if (!allowAny) res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Authorization,Content-Type');
    res.header('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));
// ─── Fingerprint machine bodies: read as RAW TEXT, BEFORE the JSON/form parsers ──
// The machine sends plain-text lines (punches, users with fingerprint templates).
// 1) It must not go through express.urlencoded first: some firmware labels the
//    upload as form data, and the form parser would swallow the lines.
// 2) A full user list or punch history is far bigger than the 100 KB default.
const deviceText = express.text({ type: () => true, limit: '25mb' });
app.use('/iclock', deviceText);
app.use('/api/essl/iclock', deviceText);

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));


app.get('/iclock/cdata',      admsHandshake);
app.post('/iclock/cdata',     admsReceiver);
app.get('/iclock/getrequest', getRequest);
app.get('/iclock/cdata.aspx',      admsHandshake);
app.post('/iclock/cdata.aspx',     admsReceiver);
app.get('/iclock/getrequest.aspx', getRequest);

// The machine confirms commands it received from /iclock/getrequest (for example
// "send punches for these dates again" or "send your user list").
app.post('/iclock/devicecmd',      deviceCmd);
app.post('/iclock/devicecmd.aspx', deviceCmd);

// Any other /iclock call from the machine (different firmware paths): log it and
// answer OK instead of 404, so nothing the machine sends is silently lost.
app.all(/^\/iclock\//, unknownDeviceCall);

const path = require('path');
app.use('/uploads', require('./middleware/authMiddleware').protect, express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is running', environment: process.env.NODE_ENV || 'development' });
});
app.get('/ping', (req, res) => res.send('pong'));

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

app.use('/api/excel-template', require('./routes/Exceltemplateroutes'));
app.use('/api', routes);

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'Internal server error' : err.message || 'Internal server error';
  res.status(statusCode).json({ success: false, message });
});

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
      serverStarted = true;
      console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    process.exit(1);
  });
