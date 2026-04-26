/**
 * server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANGES:
 *  1. workflowHandlers and initCronJobs called after mongoose.connect()
 *  2. express.text() body parser added for eSSL ADMS plain-text body
 *  3. eSSL ADMS routes registered at ROOT level (/iclock/cdata)
 *     because eSSL devices always append /iclock/cdata to the domain —
 *     you cannot change the path on the device itself.
 *  4. FIX: excelTemplateRoutes mounted BEFORE /api catch-all router
 *
 *  Device setting on eSSL:
 *    Server Address : project-management-backend-gvpy.onrender.com
 *    Server Port    : 443
 *  Device will call:
 *    GET  https://project-management-backend-gvpy.onrender.com/iclock/cdata
 *    POST https://project-management-backend-gvpy.onrender.com/iclock/cdata
 */

const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
require('dotenv').config();

const routes = require('./routes/Index');

const {
  admsHandshake,
  getRequest,
  admsReceiver,
} = require('./controllers/EsslController');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── eSSL ADMS plain-text body parser ────────────────────────────────────────
// The device POSTs attendance logs as plain text, not JSON.
// Must be registered before routes so req.body is available.
app.use('/iclock/cdata',          express.text({ type: '*/*' }));
app.use('/api/essl/iclock/cdata', express.text({ type: '*/*' }));

// ─── eSSL ADMS Device Routes (ROOT level — device cannot use /api prefix) ────
// These are called directly by the eSSL hardware, not by your frontend.
// The device always calls /iclock/cdata — this path is hardcoded in firmware.
app.get('/iclock/cdata',      admsHandshake);  // Device registration / clock sync
app.post('/iclock/cdata',     admsReceiver);   // Device pushes attendance punch logs
app.get('/iclock/getrequest', getRequest);     // Device polling for server commands

const path = require('path');
app.use('/uploads', require('./middleware/authMiddleware').protect, express.static(path.join(__dirname, 'uploads')));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'Server is running', environment: process.env.NODE_ENV || 'development' });
});

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