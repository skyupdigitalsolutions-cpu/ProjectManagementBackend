const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();

const User = require('../models/users');
const Task = require('../models/tasks');
const Policy = require('../models/policy');
const Attendance = require('../models/attendance');
const ActivityLog = require('../models/ActivityLog');
const Screenshot = require('../models/Screenshot');
const AppCategory = require('../models/AppCategory');
const { classifyBatch } = require('../services/classificationService');
const { buildTrackerDigest, sendTrackerDigest } = require('../services/trackerDigest');
const { cloudinary } = require('../config/cloudinary');
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

// Returns the caller's live clock state for today.
// `clocked_in` is true while an attendance record exists for today and has NOT
// yet been clocked out. The desktop agent uses this to keep tracking while the
// employee is clocked in and to STOP the instant they clock out.
// Works for both manual/WFH clock-ins and eSSL biometric punches, since both
// write the same Attendance record (clock_out stays null until they punch out).
async function getClockState(userId) {
  try {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const record = await Attendance.findOne({
      user_id: userId,
      date: { $gte: dayStart, $lt: dayEnd },
    })
      .select('clock_in clock_out')
      .sort({ clock_in: -1 })
      .lean();

    if (!record) {
      // No attendance record yet today — not clocked in.
      return { has_record: false, clocked_in: false, clock_in: null, clock_out: null };
    }
    return {
      has_record: true,
      clocked_in: record.clock_out == null,
      clock_in: record.clock_in || null,
      clock_out: record.clock_out || null,
    };
  } catch {
    // Fail OPEN on a transient DB error so a hiccup never silently kills an
    // employee's tracking mid-day; the next heartbeat re-checks and corrects.
    return { has_record: true, clocked_in: true, clock_in: null, clock_out: null };
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
    const clock = await getClockState(user._id);

    res.status(201).json({
      success: true,
      token,
      user_name: user.name,
      device_id: device._id,
      daily_limit_sec,
      clocked_in: clock.clocked_in,
      should_track: clock.clocked_in,
      clock_in: clock.clock_in,
      clock_out: clock.clock_out,
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
// Returns the caller's live clock state so the agent stops tracking the moment
// the employee clocks out. `daily_limit_sec` is still sent as an optional cap.
router.post('/heartbeat', trackerAuth, async (req, res) => {
  req.trackerDevice.last_seen = new Date();
  req.trackerDevice.is_tracking = Boolean(req.body.tracking);
  await req.trackerDevice.save();
  const daily_limit_sec = await getDailyLimitSec();
  const clock = await getClockState(req.trackerUser);
  res.json({
    success: true,
    daily_limit_sec,
    clocked_in: clock.clocked_in,
    should_track: clock.clocked_in,
    clock_in: clock.clock_in,
    clock_out: clock.clock_out,
  });
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

    const rows = await ActivityLog.aggregate([
      { $match: { start: { $gte: dayStart, $lt: dayEnd } } },
      {
        $group: {
          _id: { user_id: '$user_id', app_name: '$app_name', window_title: '$window_title', is_idle: '$is_idle' },
          seconds: { $sum: '$duration_sec' },
        },
      },
    ]);

    // Classify all non-idle app/title pairs via manual rules + AI cache
    const pairs = rows.filter((r) => !r._id.is_idle).map((r) => ({
      app_name: r._id.app_name, window_title: r._id.window_title,
    }));
    const { result: catMap, makeSignature } = await classifyBatch(pairs);
    const classify = (app, title) => catMap.get(makeSignature(app, title)) || 'neutral';

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
        perUser[uid][classify(r._id.app_name, r._id.window_title)] += r.seconds;
      }
    }

    const userIds = Object.keys(perUser);
    const users = await User.find({ _id: { $in: userIds } }).select('name role designation').lean();
    const nameMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
    const userRows = Object.values(perUser).map((u) => ({
      ...u,
      // Total time the tracker was ON = active + idle. This is the number that
      // should match the employee's hours-at-desk; `tracked` alone is only the
      // active (input-giving) portion of it.
      total: u.tracked + u.idle,
      name: nameMap[u.user_id] ? nameMap[u.user_id].name : 'Unknown',
      designation: nameMap[u.user_id] ? nameMap[u.user_id].designation : '',
    }));

    const totals = userRows.reduce(
      (a, u) => ({
        tracked: a.tracked + u.tracked,
        idle: a.idle + u.idle,
        total: a.total + u.total,
        productive: a.productive + u.productive,
      }),
      { tracked: 0, idle: 0, total: 0, productive: 0 }
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
          total_sec: totals.total, // active + idle = time the tracker was on
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

    const [appRows, projectRows, span] = await Promise.all([
      // Time per app+title (non-idle), for top-apps list and classification
      ActivityLog.aggregate([
        { $match: { ...match, is_idle: false } },
        { $group: { _id: { app_name: '$app_name', window_title: '$window_title' }, seconds: { $sum: '$duration_sec' } } },
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
    ]);

    // Classify each app+title via manual rules + AI cache
    const { result: catMap, makeSignature } = await classifyBatch(
      appRows.map((a) => ({ app_name: a._id.app_name, window_title: a._id.window_title }))
    );
    const classify = (app, title) => catMap.get(makeSignature(app, title)) || 'neutral';

    // Roll per-app-title rows up to per-app for the Top apps list
    const appTotals = {};
    const unproductiveItems = [];
    let tracked = 0, productive = 0, neutral = 0, unproductive = 0;
    for (const a of appRows) {
      const category = classify(a._id.app_name, a._id.window_title);
      tracked += a.seconds;
      if (category === 'productive') productive += a.seconds;
      else if (category === 'unproductive') {
        unproductive += a.seconds;
        unproductiveItems.push({
          app_name: a._id.app_name || 'Unknown',
          window_title: a._id.window_title || '',
          seconds: a.seconds,
        });
      } else neutral += a.seconds;

      const name = a._id.app_name || 'Unknown';
      if (!appTotals[name]) appTotals[name] = { app_name: name, seconds: 0, productive: 0, neutral: 0, unproductive: 0 };
      appTotals[name].seconds += a.seconds;
      appTotals[name][category] += a.seconds;
    }
    unproductiveItems.sort((a, b) => b.seconds - a.seconds);
    // Each app's shown category = its dominant category
    const topApps = Object.values(appTotals).map((t) => {
      const cat = t.productive >= t.neutral && t.productive >= t.unproductive ? 'productive'
        : t.unproductive >= t.neutral ? 'unproductive' : 'neutral';
      return { app_name: t.app_name, seconds: t.seconds, category: cat };
    }).sort((a, b) => b.seconds - a.seconds);

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
        total_sec: tracked + idle, // active + idle = time the tracker was on
        productive_sec: productive,
        neutral_sec: neutral,
        unproductive_sec: unproductive,
        productive_pct: tracked ? Math.round((productive / tracked) * 100) : 0,
        top_apps: topApps.slice(0, 8),
        unproductive_items: unproductiveItems.slice(0, 10),
        projects: projects.sort((a, b) => b.seconds - a.seconds),
      },
    });
  } catch (err) {
    console.error('Tracker employee-summary error:', err);
    res.status(500).json({ success: false, message: 'Summary failed' });
  }
});

// ─── Screenshots ───────────────────────────────────────────────────────────────
// The desktop agent captures every screen every 2 minutes while tracking and
// posts them here. Images live on Cloudinary (folder tracker-screenshots);
// Mongo keeps the metadata for the admin dashboard gallery.

const SCREENSHOT_RETENTION_DAYS = Number(process.env.SCREENSHOT_RETENTION_DAYS || 30);
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // hard cap per image

// Purge screenshots older than the retention window — Cloudinary asset first,
// then the Mongo row. Runs lazily (at most every 12h) from the upload route so
// no separate cron is needed; a failed Cloudinary delete leaves the row in
// place and the next purge retries it.
let lastShotPurge = 0;
async function purgeOldScreenshots() {
  const now = Date.now();
  if (now - lastShotPurge < 12 * 60 * 60 * 1000) return;
  lastShotPurge = now;
  try {
    const cutoff = new Date(now - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 20; i++) { // batches of 100, bounded per run
      const old = await Screenshot.find({ taken_at: { $lt: cutoff } })
        .select('public_id').limit(100).lean();
      if (!old.length) break;
      const publicIds = old.map((o) => o.public_id).filter(Boolean);
      if (publicIds.length) {
        try {
          await cloudinary.api.delete_resources(publicIds, { resource_type: 'image' });
        } catch (err) {
          console.error('Screenshot purge: cloudinary delete failed, will retry next run:', err.message);
          return; // keep Mongo rows so we never orphan Cloudinary assets
        }
      }
      await Screenshot.deleteMany({ _id: { $in: old.map((o) => o._id) } });
    }
  } catch (err) {
    console.error('Screenshot purge failed:', err.message);
  }
}

// ─── POST /api/tracker/screenshot ──────────────────────────────────────────────
// Body: { image: <base64 JPEG>, taken_at, app_name, is_idle, screen }
// Device-authenticated (same token as activity uploads).
router.post('/screenshot', trackerAuth, async (req, res) => {
  try {
    const { image, taken_at, app_name, is_idle, screen: screenName } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ success: false, message: 'image (base64) is required' });
    }
    const b64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) {
      return res.status(400).json({ success: false, message: 'Empty image' });
    }
    if (buf.length > MAX_SCREENSHOT_BYTES) {
      return res.status(413).json({ success: false, message: 'Image too large' });
    }

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'tracker-screenshots', resource_type: 'image', format: 'jpg' },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(buf);
    });

    const doc = await Screenshot.create({
      user_id: req.trackerUser,
      device_id: req.trackerDevice._id,
      taken_at: taken_at ? new Date(taken_at) : new Date(),
      url: uploaded.secure_url,
      public_id: uploaded.public_id,
      screen: String(screenName || '').slice(0, 60),
      app_name: String(app_name || '').slice(0, 120),
      is_idle: Boolean(is_idle),
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
    });

    purgeOldScreenshots(); // fire-and-forget housekeeping

    res.status(201).json({ success: true, id: doc._id });
  } catch (err) {
    console.error('Tracker screenshot upload error:', err);
    res.status(500).json({ success: false, message: 'Screenshot upload failed' });
  }
});

// ─── GET /api/tracker/screenshots?user_id=&date=YYYY-MM-DD ────────────────────
// One employee's screenshots for a day, oldest first. thumb_url is a Cloudinary
// on-the-fly transformation (no extra storage) for the dashboard grid; `url`
// is the full-resolution image for the lightbox.
router.get('/screenshots', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    if (!req.query.user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(req.query.user_id)) {
      return res.status(400).json({ success: false, message: 'Invalid user_id' });
    }
    const uid = new mongoose.Types.ObjectId(req.query.user_id);
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const shots = await Screenshot.find({ user_id: uid, taken_at: { $gte: dayStart, $lt: dayEnd } })
      .sort({ taken_at: 1 })
      .select('taken_at app_name is_idle screen url')
      .lean();

    const thumb = (url) =>
      url.includes('/upload/') ? url.replace('/upload/', '/upload/w_400,c_limit,q_auto/') : url;

    res.json({
      success: true,
      data: shots.map((s) => ({ ...s, thumb_url: thumb(s.url) })),
    });
  } catch (err) {
    console.error('Tracker screenshots list error:', err);
    res.status(500).json({ success: false, message: 'Failed to load screenshots' });
  }
});

// ─── GET /api/tracker/digest/preview?date=YYYY-MM-DD ──────────────────────────
// Returns the exact Telegram text that would be broadcast (no message is sent).
router.get('/digest/preview', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const { text, counts } = await buildTrackerDigest(date);
    return res.json({ success: true, counts, text });
  } catch (err) {
    console.error('Tracker digest preview error:', err);
    return res.status(500).json({ success: false, message: 'Preview failed' });
  }
});

// ─── POST /api/tracker/digest/send?date=YYYY-MM-DD ────────────────────────────
// Builds the per-employee summary and broadcasts it to every configured
// Telegram chat (TELEGRAM_TRACKER_CHAT_IDS, falling back to TELEGRAM_CHAT_ID).
router.post('/digest/send', protect, authorise('admin'), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const result = await sendTrackerDigest(date);
    const code = result.ok ? 200 : (result.skipped ? 400 : 502);
    return res.status(code).json({ success: result.ok, ...result });
  } catch (err) {
    console.error('Tracker digest send error:', err);
    return res.status(500).json({ success: false, message: 'Send failed' });
  }
});

module.exports = router;