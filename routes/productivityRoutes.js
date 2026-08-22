/**
 * routes/productivityRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Read + trigger the stored per-employee, per-day productivity summaries
 * (DailyProductivity), built by services/productivityAnalyzer.js.
 *
 * Mounted at /api/productivity (see routes/Index.js).
 *
 *   GET  /api/productivity?date=YYYY-MM-DD
 *        → all employees for one IST day (from the DB; runs the analyzer once
 *          if that day hasn't been computed yet)
 *
 *   GET  /api/productivity/employee?user_id=&from=YYYY-MM-DD&to=YYYY-MM-DD
 *        → one employee's stored history over a date range
 *
 *   POST /api/productivity/run?date=YYYY-MM-DD           (admin)
 *        → force a (re)compute + persist for that day, returns the rows
 *
 *   POST /api/productivity/send?date=YYYY-MM-DD          (admin)
 *        → compute + persist + broadcast the Telegram digest
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const DailyProductivity = require('../models/DailyProductivity');
const { computeDailyProductivity, dayKeyIST } = require('../services/productivityAnalyzer');
const { sendTrackerDigest } = require('../services/trackerDigest');
const { protect, authorise } = require('../middleware/authMiddleware');

// ─── GET /api/productivity?date=YYYY-MM-DD ────────────────────────────────────
// All employees for a single IST day. If nothing is stored for that day yet,
// compute it once (which also persists) and return the fresh rows.
router.get('/', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const day_key = dayKeyIST(date);

    let rows = await DailyProductivity.find({ day_key }).sort({ productive_pct: -1 }).lean();

    if (!rows.length) {
      // Not computed yet — build it now (persists), then read back.
      await computeDailyProductivity(date);
      rows = await DailyProductivity.find({ day_key }).sort({ productive_pct: -1 }).lean();
    }

    const team = rows.reduce(
      (a, r) => ({
        tracked_sec: a.tracked_sec + (r.tracked_sec || 0),
        productive_sec: a.productive_sec + (r.title?.productive_sec || 0),
      }),
      { tracked_sec: 0, productive_sec: 0 }
    );
    const team_productive_pct = team.tracked_sec
      ? Math.round((team.productive_sec / team.tracked_sec) * 100)
      : 0;

    res.json({
      success: true,
      day_key,
      team: { employees: rows.length, ...team, team_productive_pct },
      data: rows,
    });
  } catch (err) {
    console.error('Productivity list error:', err);
    res.status(500).json({ success: false, message: 'Failed to load productivity' });
  }
});

// ─── GET /api/productivity/employee?user_id=&from=&to= ────────────────────────
router.get('/employee', protect, authorise('admin', 'manager'), async (req, res) => {
  try {
    const { user_id, from, to } = req.query;
    if (!user_id || !mongoose.Types.ObjectId.isValid(user_id)) {
      return res.status(400).json({ success: false, message: 'Valid user_id is required' });
    }
    const query = { user_id: new mongoose.Types.ObjectId(user_id) };
    if (from || to) {
      query.day_key = {};
      if (from) query.day_key.$gte = String(from);
      if (to) query.day_key.$lte = String(to);
    }
    const rows = await DailyProductivity.find(query).sort({ day_key: -1 }).limit(180).lean();
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('Productivity employee error:', err);
    res.status(500).json({ success: false, message: 'Failed to load employee productivity' });
  }
});

// ─── POST /api/productivity/run?date=YYYY-MM-DD ───────────────────────────────
// Force a (re)compute for a day. Screenshots already scored are reused from
// cache, so this is cheap to re-run.
router.post('/run', protect, authorise('admin'), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const { rows, totals, day_key } = await computeDailyProductivity(date);
    res.json({ success: true, day_key, employees: rows.length, totals, data: rows });
  } catch (err) {
    console.error('Productivity run error:', err);
    res.status(500).json({ success: false, message: 'Compute failed' });
  }
});

// ─── POST /api/productivity/send?date=YYYY-MM-DD ──────────────────────────────
router.post('/send', protect, authorise('admin'), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: 'Invalid date' });
    const result = await sendTrackerDigest(date);
    const code = result.ok ? 200 : result.skipped ? 400 : 502;
    res.status(code).json({ success: result.ok, ...result });
  } catch (err) {
    console.error('Productivity send error:', err);
    res.status(500).json({ success: false, message: 'Send failed' });
  }
});

module.exports = router;