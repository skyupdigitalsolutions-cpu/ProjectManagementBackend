/**
 * routes/trackerRoutes.js — Desktop tracker (SkyUp Tracker agent) endpoints
 *
 * Mounted in routes/Index.js as:  router.use('/tracker', trackerRoutes);
 * Full paths therefore: /api/tracker/...
 *
 * DAILY LIMIT: the register + heartbeat responses include `daily_limit_sec`,
 * read from the active Policy's `full_day_hours`. The agent enforces the limit
 * locally (wall-clock elapsed since first clock-in today) and signs the user
 * out when it's reached.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();

const User = require('../models/users');
const Task = require('../models/tasks');
const Policy = require('../models/policy');
const ActivityLog = require('../models/ActivityLog');
const AppCategory = require('../models/AppCategory');
const TrackerDevice = require('../models/TrackerDevice');
const { protect, authorise } = require('../middleware/authMiddleware');

const TRACKER_JWT_SECRET = process.env.TRACKER_JWT_SECRET || process.env.JWT_SECRET;

// Read the daily tracking limit (seconds) from the active company policy.
// Falls back to 8h if no policy or field is set.
async function getDailyLimitSec() {
  try {
    const policy = await Policy.findOne({ is_active: true }).select('full_day_hours').lean();
    const hours = policy && policy.full_day_hours ? policy.full_day_hours : 8;
    return Math.round(hours * 3600);
  } catch {
    return 8 * 3600;
  }
}

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

    const daily_limit_sec = await getDailyLimitSec();

    res.status(201).json({
      success: true,
      token,
      user_name: user.name,
      device_id: device._id,
      daily_limit_sec,
    });
  } catch (err) {
    console.error('Tracker device register error:', err);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// ─── POST /api/tracker/activity/bulk ──────────────────────────────────────────
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
// Returns the current daily limit so the agent always has the latest policy value.
router.post('/heartbeat', trackerAuth, async (req, res) => {
  req.trackerDevice.last_seen = new Date();
  req.trackerDevice.is_tracking = Boolean(req.body.tracking);
  await req.trackerDevice.save();
  const daily_limit_sec = await getDailyLimitSec();
  res.json({ success: true, daily_limit_sec });
});

// ─── GET /api/tracker/tasks/mine ──────────────────────────────────────────────
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


// ─── GET /api/tracker/employee-summary?user_id=&date= ─────────────────────────
// A rolled-up daily summary for ONE employee: totals, first/last activity,
// top apps (with category), and time per project. Powers the expandable row.
router.get('/employee-summary', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    if (!req.query.user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    const mongoose = require('mongoose');
    const uid = new mongoose.Types.ObjectId(req.query.user_id);
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const match = { user_id: uid, start: { $gte: dayStart, $lt: dayEnd } };

    const [appRows, projectRows, span, categories] = await Promise.all([
      // Time per app (non-idle), for top-apps list
      ActivityLog.aggregate([
        { $match: { ...match, is_idle: false } },
        { $group: { _id: '$app_name', seconds: { $sum: '$duration_sec' } } },
        { $sort: { seconds: -1 } },
      ]),
      // Time per task -> project, for time-accounting
      ActivityLog.aggregate([
        { $match: { ...match, is_idle: false, task_id: { $ne: null } } },
        { $group: { _id: '$task_id', seconds: { $sum: '$duration_sec' } } },
        { $lookup: { from: 'tasks', localField: '_id', foreignField: '_id', as: 'task' } },
        { $unwind: { path: '$task', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'projects', localField: 'task.project_id', foreignField: '_id', as: 'project' } },
        { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$project._id',
            project_name: { $first: '$project.name' },
            seconds: { $sum: '$seconds' },
          },
        },
        { $sort: { seconds: -1 } },
      ]),
      // First and last activity of the day
      ActivityLog.aggregate([
        { $match: match },
        { $group: { _id: null, first: { $min: '$start' }, last: { $max: '$end' } } },
      ]),
      AppCategory.find({ is_active: true }).sort({ priority: -1 }).lean(),
    ]);

    const classify = (appName) => {
      const name = (appName || '').toLowerCase();
      const hit = categories.find((c) => name.includes(c.pattern));
      return hit ? hit.category : 'neutral';
    };

    let tracked = 0, productive = 0, neutral = 0, unproductive = 0;
    const topApps = appRows.map((a) => {
      const category = classify(a._id);
      tracked += a.seconds;
      if (category === 'productive') productive += a.seconds;
      else if (category === 'unproductive') unproductive += a.seconds;
      else neutral += a.seconds;
      return { app_name: a._id, seconds: a.seconds, category };
    });

    // Idle total (separate query kept simple)
    const idleAgg = await ActivityLog.aggregate([
      { $match: { ...match, is_idle: true } },
      { $group: { _id: null, seconds: { $sum: '$duration_sec' } } },
    ]);
    const idle = idleAgg.length ? idleAgg[0].seconds : 0;

    const projects = projectRows.map((p) => ({
      project_name: p.project_name || 'Untagged',
      seconds: p.seconds,
    }));
    const untaggedSec = tracked - projects.reduce((s, p) => s + p.seconds, 0);
    if (untaggedSec > 0) projects.push({ project_name: 'No task', seconds: untaggedSec });

    res.json({
      success: true,  
      data: {
        date: dayStart.toISOString().slice(0, 10),
        first_activity: span.length ? span[0].first : null,
        last_activity: span.length ? span[0].last : null,
        tracked_sec: tracked,
        idle_sec: idle,
        productive_sec: productive,
        neutral_sec: neutral,
        unproductive_sec: unproductive,
        productive_pct: tracked ? Math.round((productive / tracked) * 100) : 0,
        top_apps: topApps.slice(0, 8),
        projects: projects.sort((a, b) => b.seconds - a.seconds),
      },
    });
  } catch (err) {
    console.error('Tracker employee-summary error:', err);
    res.status(500).json({ success: false, message: 'Summary failed' });
  }
});

module.exports = router;