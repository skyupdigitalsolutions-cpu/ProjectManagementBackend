const mongoose = require("mongoose");
const Attendance = require("../models/attendance");
const WfhRequest = require("../models/WfhRequest");

// ─── Helpers ────────────────────────────────────────────────────────────────

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({ success: false, message: error.message || "Internal server error" });
};

/** Returns a Date at midnight (00:00:00) for the given date */
const toMidnight = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Returns a Date at the last moment (23:59:59.999) of the given day */
const endOfDay = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Finds an APPROVED WFH request whose [from_date, to_date] window covers `when`.
 * Overlap test handles inclusive day ranges regardless of stored time-of-day.
 */
const getActiveWfh = (userId, when = new Date()) =>
  WfhRequest.findOne({
    user_id:   userId,
    status:    "approved",
    from_date: { $lte: endOfDay(when) },
    to_date:   { $gte: toMidnight(when) },
  }).sort({ from_date: -1 });

/**
 * Decides whether a user may clock in/out manually through the app.
 * Default: NO — attendance comes from the eSSL biometric machine.
 * Allowed only when an approved WFH window covers today, or an admin has set
 * attendance_override on the user.
 */
const evaluateManualClock = async (user) => {
  if (user.attendance_override) {
    return { allowed: true, via: "override", wfh: null };
  }
  const wfh = await getActiveWfh(user._id);
  if (wfh) return { allowed: true, via: "wfh", wfh };
  return {
    allowed: false,
    via:     null,
    wfh:     null,
    reason:  "Attendance is recorded by the biometric machine. Manual clock-in is only available during an approved work-from-home period — submit a WFH request and wait for admin approval.",
  };
};

/** Calculates hours between two Date objects, rounded to 2 decimal places */
const calcHours = (clockIn, clockOut) =>
  Math.round(((clockOut - clockIn) / (1000 * 60 * 60)) * 100) / 100;

/**
 * Derives attendance status from clock-in time.
 * Work start = 09:00. Late threshold = 09:15. Half-day < 4 hours.
 */
const deriveStatus = (clockIn, clockOut = null) => {
  const hour = new Date(clockIn).getHours();
  const minute = new Date(clockIn).getMinutes();
  const totalMinutes = hour * 60 + minute;

  if (clockOut) {
    const worked = calcHours(new Date(clockIn), new Date(clockOut));
    if (worked < 4) return "half-day";
  }

  if (totalMinutes > 9 * 60 + 15) return "late";
  return "present";
};

// ─── CLOCK IN ────────────────────────────────────────────────────────────────

/**
 * POST /attendance/clock-in
 * Employees clock themselves in. Prevents duplicate entries per day.
 */
const clockIn = async (req, res) => {
  try {
    const user_id = req.user._id;
    const now = new Date();
    const today = toMidnight(now);

    // Manual clock-in is disabled unless an approved WFH window covers today.
    const elig = await evaluateManualClock(req.user);
    if (!elig.allowed) {
      return res.status(403).json({ success: false, message: elig.reason });
    }

    const existing = await Attendance.findOne({ user_id, date: today });
    if (existing) {
      return res.status(400).json({ success: false, message: "Already clocked in for today" });
    }

    const status = deriveStatus(now);

    const record = await Attendance.create({
      user_id,
      date: today,
      clock_in: now,
      status,
      source: elig.via === "wfh" ? "wfh" : "manual",
    });

    return res.status(201).json({ success: true, message: "Clocked in successfully", data: record });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── CLOCK OUT ───────────────────────────────────────────────────────────────

/**
 * PATCH /attendance/clock-out
 * Employees clock themselves out. Calculates hours_worked and refines status.
 */
const clockOut = async (req, res) => {
  try {
    const user_id = req.user._id;
    const today = toMidnight();

    const record = await Attendance.findOne({ user_id, date: today });

    if (!record) {
      return res.status(404).json({ success: false, message: "No clock-in record found for today" });
    }
    // Machine-managed records are closed by the eSSL device, not the app.
    if (record.source === "fingerprint") {
      return res.status(403).json({ success: false, message: "This record is managed by the biometric machine and cannot be edited from the app." });
    }
    if (record.clock_out) {
      return res.status(400).json({ success: false, message: "Already clocked out for today" });
    }

    const now = new Date();
    const hours_worked = calcHours(record.clock_in, now);
    const status = deriveStatus(record.clock_in, now);

    record.clock_out = now;
    record.hours_worked = hours_worked;
    record.status = status;
    await record.save();

    return res.status(200).json({ success: true, message: "Clocked out successfully", data: record });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET TODAY'S STATUS ──────────────────────────────────────────────────────

/**
 * GET /attendance/today
 * Returns the calling user's attendance record for today.
 */
const getTodayStatus = async (req, res) => {
  try {
    const record = await Attendance.findOne({
      user_id: req.user._id,
      date: toMidnight(),
    });

    // Tell the client whether manual clock controls should be enabled today.
    const elig = await evaluateManualClock(req.user);
    const activeWfh = elig.wfh
      ? { from_date: elig.wfh.from_date, to_date: elig.wfh.to_date, reason: elig.wfh.reason }
      : null;

    return res.status(200).json({
      success: true,
      data: record ?? null,
      can_manual_clock: elig.allowed,
      clock_mode: elig.via,          // "wfh" | "override" | null
      active_wfh: activeWfh,
      message: record ? undefined : "Not clocked in yet today",
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET MY ATTENDANCE ───────────────────────────────────────────────────────

/**
 * GET /attendance/my
 * Returns the calling user's attendance history with optional date range.
 * Query: ?from= &to= &page= &limit=
 */
const getMyAttendance = async (req, res) => {
  try {
    const { from, to, page = 1, limit = 30 } = req.query;

    const filter = { user_id: req.user._id };

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = toMidnight(new Date(from));
      if (to) filter.date.$lte = toMidnight(new Date(to));
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [records, total] = await Promise.all([
      Attendance.find(filter).sort({ date: -1 }).skip(skip).limit(Number(limit)),
      Attendance.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: records,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET USER ATTENDANCE (Admin/Manager) ─────────────────────────────────────

/**
 * GET /attendance/user/:user_id
 * Admin/Manager — view any employee's attendance history.
 * Query: ?from= &to= &status= &page= &limit=
 */
const getUserAttendance = async (req, res) => {
  try {
    const { user_id } = req.params;

    if (!isValidObjectId(user_id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    const { from, to, status, page = 1, limit = 30 } = req.query;

    const filter = { user_id };
    if (status) filter.status = status;
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = toMidnight(new Date(from));
      if (to) filter.date.$lte = toMidnight(new Date(to));
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [records, total] = await Promise.all([
      Attendance.find(filter)
        .populate("user_id", "name email department designation")
        .sort({ date: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Attendance.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: records,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET ALL ATTENDANCE (Admin) ───────────────────────────────────────────────

/**
 * GET /attendance
 * Admin/Manager — full attendance log with filters.
 * Query: ?date= &status= &department= &page= &limit=
 */
const getAllAttendance = async (req, res) => {
  try {
    const { date, status, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (date) filter.date = toMidnight(new Date(date));

    const skip = (Number(page) - 1) * Number(limit);

    const [records, total] = await Promise.all([
      Attendance.find(filter)
        .populate("user_id", "name email department designation")
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Attendance.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: records,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── ADMIN OVERRIDE ──────────────────────────────────────────────────────────

/**
 * PATCH /attendance/:id
 * Admin only — manually correct a record (status, clock times, hours).
 */
const updateAttendanceRecord = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid attendance record ID" });
    }

    const updates = { ...req.body };
    delete updates._id;
    delete updates.user_id;
    delete updates.date;

    // Recalculate hours if both times are provided
    if (updates.clock_in && updates.clock_out) {
      updates.hours_worked = calcHours(new Date(updates.clock_in), new Date(updates.clock_out));
    }

    const record = await Attendance.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate("user_id", "name email");

    if (!record) {
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }

    return res.status(200).json({ success: true, data: record });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return handleError(res, error);
  }
};

// ─── MARK ABSENT (Admin) ─────────────────────────────────────────────────────

/**
 * POST /attendance/mark-absent
 * Admin only — bulk-marks users absent for a given date if no record exists.
 * Body: { user_ids: [...], date: "YYYY-MM-DD" }
 */
const markAbsent = async (req, res) => {
  try {
    const { user_ids, date } = req.body;

    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ success: false, message: "user_ids must be a non-empty array" });
    }
    if (!date) {
      return res.status(400).json({ success: false, message: "date is required" });
    }

    const targetDate = toMidnight(new Date(date));

    // Only create absent records where none exist yet
    const existing = await Attendance.find({ user_id: { $in: user_ids }, date: targetDate }).select("user_id");
    const existingIds = new Set(existing.map((r) => r.user_id.toString()));

    const toCreate = user_ids
      .filter((id) => !existingIds.has(id.toString()))
      .map((user_id) => ({
        user_id,
        date: targetDate,
        clock_in: targetDate,   // placeholder; status drives the absent flag
        status: "absent",
      }));

    if (toCreate.length === 0) {
      return res.status(200).json({ success: true, message: "All users already have records for this date" });
    }

    await Attendance.insertMany(toCreate);

    return res.status(201).json({
      success: true,
      message: `${toCreate.length} absent record(s) created`,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── MONTHLY SUMMARY ─────────────────────────────────────────────────────────

/**
 * GET /attendance/summary/:user_id?month=YYYY-MM
 * Returns a monthly breakdown: days present/absent/late/on-leave + total hours.
 */
const getMonthlySummary = async (req, res) => {
  try {
    const { user_id } = req.params;
    const { month } = req.query; // e.g. "2024-06"

    if (!isValidObjectId(user_id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    // Employees can only view their own summary
    if (req.user.role === "employee" && req.user._id.toString() !== user_id) {
      return res.status(403).json({ success: false, message: "Not authorised" });
    }

    let from, to;
    if (month) {
      const [y, m] = month.split("-").map(Number);
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 0);         // last day of the month
    } else {
      const now = new Date();
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }

    const records = await Attendance.find({
      user_id,
      date: { $gte: toMidnight(from), $lte: toMidnight(to) },
    });

    const summary = records.reduce(
      (acc, r) => {
        acc.total_days++;
        acc[r.status] = (acc[r.status] || 0) + 1;
        acc.total_hours += r.hours_worked || 0;
        return acc;
      },
      { total_days: 0, total_hours: 0 }
    );

    summary.total_hours = Math.round(summary.total_hours * 100) / 100;

    return res.status(200).json({ success: true, data: summary, records });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = {
  clockIn,
  clockOut,
  getTodayStatus,
  getMyAttendance,
  getUserAttendance,
  getAllAttendance,
  updateAttendanceRecord,
  markAbsent,
  getMonthlySummary,
};