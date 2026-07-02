/**
 * routes/trackerRoutes.js — Desktop tracker (SkyUp Tracker agent) endpoints
 *
 * Mounted in routes/Index.js as:  router.use('/tracker', trackerRoutes);
 * Full paths therefore: /api/tracker/...
 *
 * Device auth is a SEPARATE long-lived JWT (scope: 'tracker') so revoking a
 * device never touches normal login sessions. Admin/manager dashboard routes
 * use the normal protect + authorise middleware.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();

const User = require('../models/users');
const Task = require('../models/tasks');
const ActivityLog = require('../models/ActivityLog');
const AppCategory = require('../models/AppCategory');
const TrackerDevice = require('../models/TrackerDevice');
const { protect, authorise } = require('../middleware/authMiddleware');

const TRACKER_JWT_SECRET = process.env.TRACKER_JWT_SECRET || process.env.JWT_SECRET;

// ─── Device auth middleware ───────────────────────────────────────────────────
const trackerAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authorised, no token' });
    }
    const decoded = jwt.verify(authHeader.split(' ')[1], TRACKER_JWT_SECRET);
    if (decoded.scope !== 'tracker') throw new Error('wrong scope');

    const device = await TrackerDevice.findById(decoded.device_id);
    if (!device || !device.is_active) {
      return res.status(401).json({ success: false, message: 'Device revoked' });
    }
    req.trackerUser = decoded.user_id;
    req.trackerDevice = device;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
};

// ─── POST /api/tracker/device/register ────────────────────────────────────────
// Body: { email, password, device_name, platform }
router.post('/device/register', async (req, res) => {
  try {
    const { email, password, device_name, platform } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = await User.findOne({ email }).select('+password');
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.status === 'inactive') {
      return res.status(403).json({ success: false, message: 'Account is inactive' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const device = await TrackerDevice.create({
      user_id: user._id,
      device_name: device_name || 'desktop',
      platform: platform || 'win32',
      last_seen: new Date(),
    });

    const token = jwt.sign(
      { user_id: user._id, device_id: device._id, scope: 'tracker' },
      TRACKER_JWT_SECRET,
      { expiresIn: '180d' }
    );

    res.status(201).json({ success: true, token, user_name: user.name, device_id: device._id });
  } catch (err) {
    console.error('Tracker device register error:', err);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// ─── POST /api/tracker/activity/bulk ──────────────────────────────────────────
// Body: { entries: [...] } — idempotent via unique entry_id
router.post('/activity/bulk', trackerAuth, async (req, res) => {
  try {
    const entries = (req.body.entries || []).slice(0, 500).map((e) => ({
      entry_id: e.entry_id,
      user_id: req.trackerUser,
      device_id: req.trackerDevice._id,
      app_name: String(e.app_name || 'Unknown').slice(0, 120),
      window_title: String(e.window_title || '').slice(0, 300),
      is_idle: Boolean(e.is_idle),
      task_id: e.task_id || null,
      start: new Date(e.start),
      end: new Date(e.end),
      duration_sec: Math.max(0, Number(e.duration_sec) || 0),
    }));

    if (!entries.length) return res.json({ success: true, inserted: 0 });

    let inserted = 0;
    try {
      const result = await ActivityLog.insertMany(entries, { ordered: false });
      inserted = result.length;
    } catch (err) {
      // E11000 duplicates = agent retried an already-saved batch. Expected.
      if (err.code === 11000 || err.writeErrors) {
        inserted = err.insertedDocs ? err.insertedDocs.length : 0;
      } else {
        throw err;
      }
    }
    res.json({ success: true, inserted });
  } catch (err) {
    console.error('Tracker bulk ingest error:', err);
    res.status(500).json({ success: false, message: 'Ingest failed' });
  }
});

// ─── POST /api/tracker/heartbeat ──────────────────────────────────────────────
router.post('/heartbeat', trackerAuth, async (req, res) => {
  req.trackerDevice.last_seen = new Date();
  req.trackerDevice.is_tracking = Boolean(req.body.tracking);
  await req.trackerDevice.save();
  res.json({ success: true });
});

// ─── GET /api/tracker/tasks/mine ──────────────────────────────────────────────
// Open tasks assigned to the agent's user, for the timer dropdown
router.get('/tasks/mine', trackerAuth, async (req, res) => {
  try {
    const tasks = await Task.find({
      assigned_to: req.trackerUser,
      status: { $in: ['todo', 'in-progress', 'on-hold', 'blocked'] },
    })
      .select('title project_id status')
      .populate('project_id', 'name')
      .sort({ priority: -1, updatedAt: -1 })
      .limit(100)
      .lean();

    res.json({
      success: true,
      data: tasks.map((t) => ({
        _id: t._id,
        title: t.title,
        project_name: t.project_id ? t.project_id.name : null,
      })),
    });
  } catch (err) {
    console.error('Tracker tasks fetch error:', err);
    res.status(500).json({ success: false, message: 'Task fetch failed' });
  }
});

// ─── GET /api/tracker/summary?date=YYYY-MM-DD ─────────────────────────────────
// Admin/manager dashboard: KPIs + per-user productivity split
router.get('/summary', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const [rows, categories] = await Promise.all([
      ActivityLog.aggregate([
        { $match: { start: { $gte: dayStart, $lt: dayEnd } } },
        {
          $group: {
            _id: { user_id: '$user_id', app_name: '$app_name', is_idle: '$is_idle' },
            seconds: { $sum: '$duration_sec' },
          },
        },
      ]),
      AppCategory.find({ is_active: true }).sort({ priority: -1 }).lean(),
    ]);

    const classify = (appName) => {
      const name = (appName || '').toLowerCase();
      const hit = categories.find((c) => name.includes(c.pattern));
      return hit ? hit.category : 'neutral';
    };

    const perUser = {};
    for (const r of rows) {
      const uid = String(r._id.user_id);
      if (!perUser[uid]) {
        perUser[uid] = { user_id: uid, tracked: 0, idle: 0, productive: 0, neutral: 0, unproductive: 0 };
      }
      if (r._id.is_idle) {
        perUser[uid].idle += r.seconds;
      } else {
        perUser[uid].tracked += r.seconds;
        perUser[uid][classify(r._id.app_name)] += r.seconds;
      }
    }

    // Attach names/roles in one query
    const userIds = Object.keys(perUser);
    const users = await User.find({ _id: { $in: userIds } }).select('name role designation').lean();
    const nameMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
    const userRows = Object.values(perUser).map((u) => ({
      ...u,
      name: nameMap[u.user_id] ? nameMap[u.user_id].name : 'Unknown',
      designation: nameMap[u.user_id] ? nameMap[u.user_id].designation : '',
    }));

    const totals = userRows.reduce(
      (a, u) => ({
        tracked: a.tracked + u.tracked,
        idle: a.idle + u.idle,
        productive: a.productive + u.productive,
      }),
      { tracked: 0, idle: 0, productive: 0 }
    );

    const activeSince = new Date(Date.now() - 3 * 60 * 1000);
    const activeNow = await TrackerDevice.countDocuments({
      is_tracking: true,
      last_seen: { $gte: activeSince },
    });

    res.json({
      success: true,
      data: {
        date: dayStart.toISOString().slice(0, 10),
        totals: {
          tracked_sec: totals.tracked,
          idle_sec: totals.idle,
          productive_pct: totals.tracked ? Math.round((totals.productive / totals.tracked) * 100) : 0,
          active_now: activeNow,
        },
        users: userRows,
      },
    });
  } catch (err) {
    console.error('Tracker summary error:', err);
    res.status(500).json({ success: false, message: 'Summary failed' });
  }
});

// ─── GET /api/tracker/activity?user_id=&date= ─────────────────────────────────
// Timeline drill-down for one employee's day
router.get('/activity', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    if (!req.query.user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const logs = await ActivityLog.find({
      user_id: req.query.user_id,
      start: { $gte: dayStart, $lt: dayEnd },
    })
      .sort({ start: 1 })
      .select('app_name window_title is_idle task_id start end duration_sec')
      .populate('task_id', 'title')
      .lean();

    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Tracker activity error:', err);
    res.status(500).json({ success: false, message: 'Activity fetch failed' });
  }
});

// ─── GET /api/tracker/devices ─────────────────────────────────────────────────
// Admin: list paired devices (with kill-switch info)
router.get('/devices', protect, authorise('admin'), async (req, res) => {
  const devices = await TrackerDevice.find()
    .populate('user_id', 'name email')
    .sort({ last_seen: -1 })
    .lean();
  res.json({ success: true, data: devices });
});

// ─── PATCH /api/tracker/devices/:id/revoke ────────────────────────────────────
router.patch('/devices/:id/revoke', protect, authorise('admin'), async (req, res) => {
  const device = await TrackerDevice.findByIdAndUpdate(
    req.params.id,
    { is_active: false, is_tracking: false },
    { new: true }
  );
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json({ success: true, data: device });
});

module.exports = router;