const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/users');
const Task = require('../models/tasks');
const Policy = require('../models/policy');
const Attendance = require('../models/attendance');
const { istDayRange } = require('../services/attendanceRules');
const ActivityLog = require('../models/ActivityLog');
const Screenshot = require('../models/Screenshot');
const IdleReason = require('../models/IdleReason');
const AppCategory = require('../models/AppCategory');
const DailyProductivity = require('../models/DailyProductivity');
const { classifyBatch } = require('../services/classificationService');
const { buildTrackerDigest, sendTrackerDigest } = require('../services/trackerDigest');
const { cloudinary } = require('../config/cloudinary');
const TrackerDevice = require('../models/TrackerDevice');
const { protect, authorise } = require('../middleware/authMiddleware');

const TRACKER_JWT_SECRET = process.env.TRACKER_JWT_SECRET || process.env.JWT_SECRET;

// Must match the desktop tracker's IDLE_AFTER_SEC (src capture / main.js).
// An ActivityLog entry is only LABELLED is_idle after this many seconds without
// input, so the real idle stretch began IDLE_AFTER_SEC earlier than entry.start
// and is that much longer than entry.duration_sec. We re-apply the same offset
// here so idle windows shown/saved from the web app match what the tracker used
// to compute in its own popup.
const IDLE_AFTER_SEC = 240;

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
    // FIX: "today" is the IST day (Attendance.date is stored at 00:00 IST, see
    // services/attendanceRules.js). The old server-midnight range missed
    // today's punch on a non-IST server, so tracking stopped as if the
    // employee hadn't clocked in. This range also finds older records.
    const record = await Attendance.findOne({
      user_id: userId,
      date: istDayRange(new Date()),
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
// Build one employee's day summary (tracked/idle/productive breakdown, top apps,
// projects and stated idle reasons). Shared by the admin `employee-summary`
// route and the employee-facing `my/summary` route so both return identical
// shapes. `uid` may be an ObjectId or a string.
async function buildDaySummary(uid, date) {
  const mongoose = require('mongoose');
  uid = uid instanceof mongoose.Types.ObjectId ? uid : new mongoose.Types.ObjectId(uid);
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

  // ── Untracked gaps ──────────────────────────────────────────────────────────
  // Stretches where NO entry exists between one activity ending and the next
  // starting. Idle time is a real entry (is_idle), so a genuine idle stretch is
  // NOT a gap — only true absence of data is: the machine was asleep/suspended,
  // shut down, or the tracker wasn't running. This is what explains a "total
  // time" that's smaller than (last activity − first activity).
  const GAP_MIN_SEC = 180; // ignore sub-3-minute gaps (normal scheduler jitter)
  const gapRows = await ActivityLog.find(match).sort({ start: 1 }).select('start end').lean();
  const gaps = [];
  let untracked = 0;
  for (let i = 1; i < gapRows.length; i++) {
    const prevEnd = new Date(gapRows[i - 1].end).getTime();
    const curStart = new Date(gapRows[i].start).getTime();
    const gapSec = Math.round((curStart - prevEnd) / 1000);
    if (gapSec >= GAP_MIN_SEC) {
      gaps.push({ start: new Date(prevEnd), end: new Date(curStart), seconds: gapSec });
      untracked += gapSec;
    }
  }
  gaps.sort((a, b) => b.seconds - a.seconds);

  // Classify each app+title via manual rules + AI cache
  const { result: catMap, makeSignature } = await classifyBatch(
    appRows.map((a) => ({ app_name: a._id.app_name, window_title: a._id.window_title }))
  );
  const classify = (app, title) => catMap.get(makeSignature(app, title)) || 'neutral';

  // Roll per-app-title rows up to per-app for the Top apps list, and keep a
  // per-category breakdown of the specific app + window titles so the admin can
  // see EXACTLY which activities counted as productive / neutral / unproductive.
  const appTotals = {};
  const productiveItems = [];
  const neutralItems = [];
  const unproductiveItems = [];
  let tracked = 0, productive = 0, neutral = 0, unproductive = 0;
  for (const a of appRows) {
    const category = classify(a._id.app_name, a._id.window_title);
    tracked += a.seconds;
    const item = {
      app_name: a._id.app_name || 'Unknown',
      window_title: a._id.window_title || '',
      seconds: a.seconds,
    };
    if (category === 'productive') {
      productive += a.seconds;
      productiveItems.push(item);
    } else if (category === 'unproductive') {
      unproductive += a.seconds;
      unproductiveItems.push(item);
    } else {
      neutral += a.seconds;
      neutralItems.push(item);
    }

    const name = a._id.app_name || 'Unknown';
    if (!appTotals[name]) appTotals[name] = { app_name: name, seconds: 0, productive: 0, neutral: 0, unproductive: 0 };
    appTotals[name].seconds += a.seconds;
    appTotals[name][category] += a.seconds;
  }
  const bySeconds = (a, b) => b.seconds - a.seconds;
  productiveItems.sort(bySeconds);
  neutralItems.sort(bySeconds);
  unproductiveItems.sort(bySeconds);
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

  // The employee's stated reasons for each 4+ min idle stretch that day
  const idleReasons = await IdleReason.find({ user_id: uid, idle_start: { $gte: dayStart, $lt: dayEnd } })
    .sort({ idle_start: 1 })
    .select('idle_start idle_end duration_sec reason')
    .lean();

  const projects = projectRows.map((p) => ({
    project_name: p.project_name || 'Untagged',
    seconds: p.seconds,
  }));
  const untaggedSec = tracked - projects.reduce((s, p) => s + p.seconds, 0);
  if (untaggedSec > 0) projects.push({ project_name: 'No task', seconds: untaggedSec });

  return {
    date: dayStart.toISOString().slice(0, 10),
    first_activity: span.length ? span[0].first : null,
    last_activity: span.length ? span[0].last : null,
    tracked_sec: tracked,
    idle_sec: idle,
    total_sec: tracked + idle, // active + idle = time the tracker was on
    // Span = last activity − first activity. untracked = span − total (the time
    // the machine was asleep/off or the tracker wasn't running).
    span_sec: span.length && span[0].first && span[0].last
      ? Math.max(0, Math.round((new Date(span[0].last).getTime() - new Date(span[0].first).getTime()) / 1000))
      : 0,
    untracked_sec: untracked,
    gaps: gaps.slice(0, 8),
    idle_reasons: idleReasons,
    productive_sec: productive,
    neutral_sec: neutral,
    unproductive_sec: unproductive,
    productive_pct: tracked ? Math.round((productive / tracked) * 100) : 0,
    top_apps: topApps.slice(0, 8),
    productive_items: productiveItems.slice(0, 15),
    neutral_items: neutralItems.slice(0, 15),
    unproductive_items: unproductiveItems.slice(0, 15),
    projects: projects.sort((a, b) => b.seconds - a.seconds),
  };
}

router.get('/employee-summary', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    if (!req.query.user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const data = await buildDaySummary(req.query.user_id, date);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Tracker employee-summary error:', err);
    res.status(500).json({ success: false, message: 'Summary failed' });
  }
});

// ─── AI daily brief ───────────────────────────────────────────────────────────
// Turns the day's numbers into a short, factual paragraph an admin can skim.
// Uses the same OpenAI key/model as the classifier, and caches the result on the
// DailyProductivity row (keyed by a hash of the numbers) so repeated views don't
// re-call the API. No key -> returns an empty brief, never an error.
const OPENAI_BRIEF_URL = 'https://api.openai.com/v1/chat/completions';
const BRIEF_MODEL = process.env.PRODUCTIVITY_BRIEF_MODEL || 'gpt-4o-mini';

function briefContext(data, name) {
  const mins = (s) => `${Math.round((s || 0) / 60)} min`;
  const list = (arr) =>
    (arr || []).slice(0, 5)
      .map((i) => `${i.app_name}${i.window_title ? ': ' + i.window_title : ''} (${mins(i.seconds)})`)
      .join('; ') || 'none';
  const unprodPct = data.tracked_sec ? Math.round((data.unproductive_sec / data.tracked_sec) * 100) : 0;
  return [
    name ? `Employee: ${name}` : null,
    `Active tracked time: ${mins(data.tracked_sec)}`,
    `Idle time: ${mins(data.idle_sec)}`,
    `Untracked time (machine asleep/off or tracker not running): ${mins(data.untracked_sec)}`,
    `Productive: ${data.productive_pct}% (${mins(data.productive_sec)})`,
    `Unproductive: ${unprodPct}% (${mins(data.unproductive_sec)})`,
    `Top productive activity: ${list(data.productive_items)}`,
    `Top unproductive activity: ${list(data.unproductive_items)}`,
    `Projects worked on: ${(data.projects || []).slice(0, 5).map((p) => `${p.project_name} (${mins(p.seconds)})`).join('; ') || 'none'}`,
    `Idle stretches explained by employee: ${(data.idle_reasons || []).length}`,
  ].filter(Boolean).join('\n');
}

async function generateBrief(context) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '';
  const prompt =
    `You are writing a short daily activity summary for an admin reviewing an employee's ` +
    `computer-usage tracking at a web development and digital marketing agency. ` +
    `Write 2 to 3 plain, factual sentences. Describe how the time was spent, the balance of ` +
    `productive vs unproductive activity, the main tools or projects, and mention idle time or ` +
    `notable unproductive time only if it is significant. Keep a neutral, professional tone — ` +
    `do not praise, scold, or speculate, and do not state anything that is not in the data.\n\n` +
    `Data:\n${context}\n\nSummary:`;
  try {
    const res = await fetch(OPENAI_BRIEF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      console.error('OpenAI brief failed:', res.status);
      return '';
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    console.error('OpenAI brief error:', err.message);
    return '';
  }
}

// GET /api/tracker/employee-summary/brief?user_id=&date=&refresh=1
router.get('/employee-summary/brief', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    if (!req.query.user_id || !mongoose.Types.ObjectId.isValid(req.query.user_id)) {
      return res.status(400).json({ success: false, message: 'Valid user_id is required' });
    }
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });

    const uid = new mongoose.Types.ObjectId(req.query.user_id);
    const data = await buildDaySummary(uid, date);
    const day_key = data.date;

    // Nothing tracked -> nothing to summarise.
    if (!data.tracked_sec && !data.idle_sec) {
      return res.json({ success: true, brief: '', empty: true });
    }

    const user = await User.findById(uid).select('name').lean();
    const context = briefContext(data, user && user.name);
    const signature = crypto.createHash('md5').update(context).digest('hex');
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

    if (!refresh) {
      const row = await DailyProductivity.findOne({ user_id: uid, day_key }).select('brief brief_hash').lean();
      if (row && row.brief && row.brief_hash === signature) {
        return res.json({ success: true, brief: row.brief, cached: true });
      }
    }

    const brief = await generateBrief(context);
    if (!brief) {
      return res.json({ success: true, brief: '', unavailable: true });
    }
    // Cache on the existing daily row if one exists (don't create a partial row —
    // that would pollute the productivity list until the analyzer fills it).
    DailyProductivity.updateOne(
      { user_id: uid, day_key },
      { $set: { brief, brief_hash: signature } }
    ).catch(() => {});

    res.json({ success: true, brief, cached: false });
  } catch (err) {
    console.error('Tracker brief error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate summary' });
  }
});

// ─── GET /api/tracker/my/summary?date=YYYY-MM-DD ──────────────────────────────
// The logged-in employee's OWN day summary — same shape as employee-summary but
// self-scoped, so any authenticated user can view their own productivity from
// the web app without admin/manager rights.
router.get('/my/summary', protect, async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const data = await buildDaySummary(req.user._id, date);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Tracker my/summary error:', err);
    res.status(500).json({ success: false, message: 'Summary failed' });
  }
});

// ─── GET /api/tracker/my/idle-stretches?date=YYYY-MM-DD ───────────────────────
// Every idle stretch the tracker recorded for the caller on that day, each with
// the reason they've already given (if any). This is what the web page lists so
// the employee can explain each idle stretch — the job the tracker popup used
// to do. idle_start/duration_sec are offset by IDLE_AFTER_SEC to match the
// tracker's own reckoning of the stretch.
router.get('/my/idle-stretches', protect, async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const entries = await ActivityLog.find({
      user_id: req.user._id,
      is_idle: true,
      start: { $gte: dayStart, $lt: dayEnd },
    })
      .sort({ start: 1 })
      .select('entry_id start end duration_sec')
      .lean();

    const ids = entries.map((e) => e.entry_id);
    const reasons = ids.length
      ? await IdleReason.find({ reason_id: { $in: ids } }).select('reason_id reason updatedAt').lean()
      : [];
    const reasonMap = new Map(reasons.map((r) => [r.reason_id, r]));

    const stretches = entries.map((e) => {
      const r = reasonMap.get(e.entry_id);
      return {
        entry_id: e.entry_id,
        idle_start: new Date(new Date(e.start).getTime() - IDLE_AFTER_SEC * 1000),
        idle_end: e.end,
        duration_sec: (e.duration_sec || 0) + IDLE_AFTER_SEC,
        reason: r ? r.reason : '',
        answered: Boolean(r),
        answered_at: r ? r.updatedAt : null,
      };
    });

    res.json({
      success: true,
      data: stretches,
      pending: stretches.filter((s) => !s.answered).length,
    });
  } catch (err) {
    console.error('Tracker my/idle-stretches error:', err);
    res.status(500).json({ success: false, message: 'Failed to load idle stretches' });
  }
});

// ─── POST /api/tracker/my/idle-reason ─────────────────────────────────────────
// The employee's reason for one of their own idle stretches, submitted from the
// web app instead of the desktop popup. Body: { entry_id, reason }.
// The stretch is identified by the ActivityLog entry_id, which must belong to
// the caller and be an idle entry — so nobody can label someone else's time.
// Upserts on reason_id, so the employee can edit a reason by resubmitting.
router.post('/my/idle-reason', protect, async (req, res) => {
  try {
    const { entry_id, reason } = req.body || {};
    const clean = String(reason || '').trim().slice(0, 300);
    if (!entry_id || !clean) {
      return res.status(400).json({ success: false, message: 'entry_id and reason are required' });
    }

    const entry = await ActivityLog.findOne({
      entry_id: String(entry_id),
      user_id: req.user._id,
      is_idle: true,
    })
      .select('entry_id device_id start end duration_sec')
      .lean();

    if (!entry) {
      return res.status(404).json({ success: false, message: 'Idle stretch not found' });
    }

    const idle_start = new Date(new Date(entry.start).getTime() - IDLE_AFTER_SEC * 1000);
    const idle_end = new Date(entry.end);
    const duration_sec = (entry.duration_sec || 0) + IDLE_AFTER_SEC;

    await IdleReason.findOneAndUpdate(
      { reason_id: String(entry.entry_id).slice(0, 64) },
      {
        $set: {
          user_id: req.user._id,
          device_id: entry.device_id,
          idle_start,
          idle_end,
          duration_sec,
          reason: clean,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) {
      // Concurrent upsert on the same reason_id — the reason is stored, treat as success.
      return res.json({ success: true, duplicate: true });
    }
    console.error('Tracker my/idle-reason error:', err);
    res.status(500).json({ success: false, message: 'Failed to save idle reason' });
  }
});

// ─── POST /api/tracker/idle-reason ─────────────────────────────────────────────
// The employee's answer to the "why were you idle?" prompt (idle >= 4 min).
// Body: { reason_id, idle_start, idle_end, duration_sec, reason }
// Idempotent: reason_id is the tracker entry UUID, so buffered retries after a
// network failure can never insert the same reason twice.
router.post('/idle-reason', trackerAuth, async (req, res) => {
  try {
    const { reason_id, idle_start, idle_end, duration_sec, reason } = req.body || {};
    const clean = String(reason || '').trim().slice(0, 300);
    if (!reason_id || !idle_start || !idle_end || !clean) {
      return res.status(400).json({ success: false, message: 'reason_id, idle_start, idle_end and reason are required' });
    }

    try {
      await IdleReason.create({
        reason_id: String(reason_id).slice(0, 64),
        user_id: req.trackerUser,
        device_id: req.trackerDevice._id,
        idle_start: new Date(idle_start),
        idle_end: new Date(idle_end),
        duration_sec: Math.max(0, Number(duration_sec) || 0),
        reason: clean,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.json({ success: true, duplicate: true }); // retried upload — already stored
      }
      throw err;
    }

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Tracker idle-reason error:', err);
    res.status(500).json({ success: false, message: 'Failed to save idle reason' });
  }
});

// ─── Screenshots ───────────────────────────────────────────────────────────────
// The desktop agent captures every screen every 2 minutes while tracking and
// posts them here. Images live on Cloudinary (folder tracker-screenshots);
// Mongo keeps the metadata for the admin dashboard gallery.

const SCREENSHOT_RETENTION_DAYS = Number(process.env.SCREENSHOT_RETENTION_DAYS || 7);
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
