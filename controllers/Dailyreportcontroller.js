const Dailyreport = require("../models/Dailyreport");

// Helper: normalise a date to midnight local time
const toMidnight = (d) => {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt;
};

// ── POST /api/daily-reports ──────────────────────────────────────────────────
// Employee: submit or update today's report (upsert)
const submitReport = async (req, res) => {
  try {
    const { summary, tasks_completed, blockers, plan_for_tomorrow, mood } = req.body;

    if (!summary || summary.trim() === "") {
      return res.status(400).json({ success: false, message: "Summary is required" });
    }

    const today = toMidnight(new Date());

    const report = await Dailyreport.findOneAndUpdate(
      { user_id: req.user._id, date: today },
      {
        user_id: req.user._id,
        date: today,
        summary: summary.trim(),
        tasks_completed: Array.isArray(tasks_completed)
          ? tasks_completed.filter(Boolean)
          : [],
        blockers: blockers?.trim() || "",
        plan_for_tomorrow: plan_for_tomorrow?.trim() || "",
        mood: mood || "good",
      },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: "Daily report saved successfully",
      data: report,
    });
  } catch (err) {
    console.error("submitReport error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/daily-reports/my ─────────────────────────────────────────────────
// Employee: own report history (?from &to &page &limit)
const getMyReports = async (req, res) => {
  try {
    const { from, to, page = 1, limit = 10 } = req.query;
    const filter = { user_id: req.user._id };

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = toMidnight(from);
      if (to)   filter.date.$lte = toMidnight(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [reports, total] = await Promise.all([
      Dailyreport.find(filter).sort({ date: -1 }).skip(skip).limit(Number(limit)),
      Dailyreport.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: reports,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/daily-reports/today ──────────────────────────────────────────────
// Employee: get own today's report (if any)
const getTodayReport = async (req, res) => {
  try {
    const report = await Dailyreport.findOne({
      user_id: req.user._id,
      date: toMidnight(new Date()),
    });
    return res.status(200).json({ success: true, data: report || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/daily-reports ────────────────────────────────────────────────────
// Admin/Manager: list all reports (?user_id &from &to &page &limit)
const getAllReports = async (req, res) => {
  try {
    const { user_id, from, to, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (user_id) filter.user_id = user_id;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = toMidnight(from);
      if (to)   filter.date.$lte = toMidnight(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [reports, total] = await Promise.all([
      Dailyreport.find(filter)
        .populate("user_id", "name email designation department")
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Dailyreport.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: reports,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/daily-reports/user/:user_id ──────────────────────────────────────
// Admin/Manager: reports for a specific employee
const getUserReports = async (req, res) => {
  try {
    const { from, to, page = 1, limit = 10 } = req.query;
    const filter = { user_id: req.params.user_id };

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = toMidnight(from);
      if (to)   filter.date.$lte = toMidnight(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [reports, total] = await Promise.all([
      Dailyreport.find(filter)
        .populate("user_id", "name email designation department")
        .sort({ date: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Dailyreport.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: reports,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/daily-reports/:id ─────────────────────────────────────────────
// Employee: delete own report; Admin: delete any
const deleteReport = async (req, res) => {
  try {
    const report = await Dailyreport.findById(req.params.id);
    if (!report)
      return res.status(404).json({ success: false, message: "Report not found" });

    const isOwner = report.user_id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Not authorised" });
    }

    await report.deleteOne();
    return res.status(200).json({ success: true, message: "Report deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  submitReport,
  getMyReports,
  getTodayReport,
  getAllReports,
  getUserReports,
  deleteReport,
};
