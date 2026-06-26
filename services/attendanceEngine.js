/**
 * services/attendanceEngine.js  — NEW
 *
 * Core attendance resolution engine.
 * Priority order (highest → lowest):
 *   1. WFH override active   → use WFH clock-in/out record
 *   2. Biometric data exists → mark present (office)
 *   3. Approved WFH request  → mark present (wfh)
 *   4. On approved leave     → mark on-leave
 *   5. No data               → mark absent
 *
 * Also handles:
 *   - Policy-based late calculation
 *   - Comp-off generation for holiday/weekend work
 *   - Half-day detection
 *
 * PLACE AT: Project-Management-Backend/services/attendanceEngine.js
 */

const mongoose         = require('mongoose');
const Attendance       = require('../models/attendance');
const WfhRequest       = require('../models/WfhRequest');
const AttendancePolicy = require('../models/AttendancePolicy');
const CompOff          = require('../models/CompOff');
const Leave            = require('../models/leave');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toMidnight = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const calcHours = (clockIn, clockOut) =>
  Math.round(((clockOut - clockIn) / (1000 * 60 * 60)) * 100) / 100;

/**
 * Load the active attendance policy, or return defaults if none configured.
 */
async function getActivePolicy() {
  const policy = await AttendancePolicy.findOne({ is_active: true }).lean();
  if (policy) return policy;

  // Fallback defaults
  return {
    work_start_time:        '09:00',
    work_end_time:          '18:00',
    late_threshold_minutes: 15,
    half_day_hours:         4,
    full_day_hours:         8,
    weekly_offs:            [0, 6],
    holidays:               [],
    comp_off_enabled:       true,
    comp_off_on_holiday:    true,
    comp_off_on_weekend:    true,
    min_hours_for_comp_off: 8,
    comp_off_expiry_days:   90,
  };
}

/**
 * Parse "HH:MM" string into { hours, minutes }.
 */
function parseTime(str = '09:00') {
  const [h, m] = str.split(':').map(Number);
  return { hours: h || 9, minutes: m || 0 };
}

/**
 * Derive attendance status using policy rules.
 */
function deriveStatusFromPolicy(clockIn, clockOut, policy) {
  const { hours: startH, minutes: startM } = parseTime(policy.work_start_time);
  const policyStartMinutes = startH * 60 + startM;
  const threshold = policy.late_threshold_minutes ?? 15;

  const ci = new Date(clockIn);
  const clockInMinutes = ci.getHours() * 60 + ci.getMinutes();

  const lateByMinutes = Math.max(0, clockInMinutes - policyStartMinutes - threshold);

  let hoursWorked = null;
  let status      = 'present';

  if (clockOut) {
    hoursWorked = calcHours(new Date(clockIn), new Date(clockOut));
    if (hoursWorked < (policy.half_day_hours ?? 4)) {
      status = 'half-day';
      return { status, lateByMinutes, hoursWorked };
    }
  }

  if (clockInMinutes > policyStartMinutes + threshold) {
    status = 'late';
  }

  return { status, lateByMinutes, hoursWorked };
}

/**
 * Check if a given date is a holiday or weekly-off per the policy.
 */
function isHolidayOrWeekend(dateObj, policy) {
  const day = new Date(dateObj).getDay(); // 0=Sun … 6=Sat
  const isWeekend  = (policy.weekly_offs ?? [0, 6]).includes(day);
  const isHoliday  = (policy.holidays ?? []).some(h => {
    return toMidnight(h.date).getTime() === toMidnight(dateObj).getTime();
  });
  return { isWeekend, isHoliday, isNonWorkingDay: isWeekend || isHoliday };
}

// ─── WFH Override Check ───────────────────────────────────────────────────────

/**
 * Returns true if the user has WFH override enabled.
 * Called by eSSL sync to decide whether to skip biometric processing.
 */
async function isWfhOverrideActive(user) {
  return user.attendance_override === true && user.work_mode === 'wfh';
}

// ─── Approved WFH Request Check ───────────────────────────────────────────────

/**
 * Returns the approved WFH request document if one covers the given date.
 */
async function getApprovedWfhRequest(userId, dateObj) {
  const date = toMidnight(dateObj);
  const request = await WfhRequest.findOne({
    user_id:    userId,
    status:     'approved',
    from_date:  { $lte: date },
    to_date:    { $gte: date },
  });
  return request;
}

// ─── Approved Leave Check ─────────────────────────────────────────────────────

async function getApprovedLeave(userId, dateObj) {
  const date = toMidnight(dateObj);
  return Leave.findOne({
    user_id:   userId,
    status:    'approved',
    from_date: { $lte: date },
    to_date:   { $gte: date },
  });
}

// ─── WFH Clock-In ────────────────────────────────────────────────────────────

/**
 * Main WFH clock-in handler.
 * Called from the WFH attendance controller.
 *
 * @param {Object} user        - Mongoose User document
 * @param {Object} options     - { location: { lat, lng, accuracy } }
 * @returns {Object}           - { record, created }
 */
async function wfhClockIn(user, options = {}) {
  const now   = new Date();
  const today = toMidnight(now);

  // Duplicate guard
  const existing = await Attendance.findOne({ user_id: user._id, date: today });
  if (existing) {
    throw new Error('Already clocked in for today');
  }

  const policy = await getActivePolicy();
  const { status, lateByMinutes } = deriveStatusFromPolicy(now, null, policy);

  // Determine if this is an admin override or an approved WFH request
  const isOverride = await isWfhOverrideActive(user);
  let wfhRequestId = null;

  if (!isOverride) {
    const wfhReq = await getApprovedWfhRequest(user._id, today);
    if (!wfhReq) {
      throw new Error('No approved WFH request for today and no WFH override set');
    }
    wfhRequestId = wfhReq._id;
  }

  const record = await Attendance.create({
    user_id:         user._id,
    date:            today,
    clock_in:        now,
    status:          status === 'present' ? 'wfh' : status,
    source:          'wfh',
    work_mode:       'wfh',
    wfh_request_id:  wfhRequestId,
    is_override:     isOverride,
    late_by_minutes: lateByMinutes,
    location:        options.location ?? {},
  });

  return { record, created: true };
}

// ─── WFH Clock-Out ───────────────────────────────────────────────────────────

/**
 * Main WFH clock-out handler.
 */
async function wfhClockOut(user) {
  const today = toMidnight();

  const record = await Attendance.findOne({
    user_id: user._id,
    date:    today,
    source:  'wfh',
  });

  if (!record) {
    throw new Error('No WFH clock-in record found for today');
  }
  if (record.clock_out) {
    throw new Error('Already clocked out for today');
  }

  const now          = new Date();
  const policy       = await getActivePolicy();
  const hoursWorked  = calcHours(record.clock_in, now);
  const { status }   = deriveStatusFromPolicy(record.clock_in, now, policy);

  record.clock_out    = now;
  record.hours_worked = hoursWorked;
  record.status       = status === 'present' ? 'wfh' : status;

  await record.save();
  return record;
}

// ─── Comp-Off Generation ──────────────────────────────────────────────────────

/**
 * After eSSL sync or WFH clock-out, check if comp-off should be generated.
 * Called automatically when an attendance record is saved.
 *
 * @param {ObjectId}  userId
 * @param {Date}      dateObj   - the date worked
 * @param {number}    hoursWorked
 */
async function maybeGenerateCompOff(userId, dateObj, attendanceId, hoursWorked) {
  const policy = await getActivePolicy();
  if (!policy.comp_off_enabled) return null;

  const { isWeekend, isHoliday } = isHolidayOrWeekend(dateObj, policy);
  const qualifies = (isHoliday && policy.comp_off_on_holiday)
                  || (isWeekend && policy.comp_off_on_weekend);

  if (!qualifies) return null;
  if ((hoursWorked ?? 0) < policy.min_hours_for_comp_off) return null;

  // Avoid duplicates
  const existing = await CompOff.findOne({ user_id: userId, worked_on: toMidnight(dateObj) });
  if (existing) return existing;

  const expiresOn = new Date(dateObj);
  expiresOn.setDate(expiresOn.getDate() + (policy.comp_off_expiry_days ?? 90));

  const compOff = await CompOff.create({
    user_id:       userId,
    worked_on:     toMidnight(dateObj),
    attendance_id: attendanceId,
    reason:        isHoliday ? 'Worked on holiday' : 'Worked on weekend',
    days_earned:   hoursWorked >= policy.full_day_hours ? 1 : 0.5,
    days_remaining: hoursWorked >= policy.full_day_hours ? 1 : 0.5,
    expires_on:    expiresOn,
  });

  // Mark attendance record
  await Attendance.findByIdAndUpdate(attendanceId, { comp_off_earned: true });

  console.log(`[AttendanceEngine] Comp-off generated for user ${userId} on ${toMidnight(dateObj).toDateString()}`);
  return compOff;
}

// ─── Full Resolution (for nightly reconciliation) ────────────────────────────

/**
 * Resolve a single user's attendance for a given date.
 * Used by admin reconciliation and nightly cron.
 *
 * Priority:
 *   1. WFH override → existing WFH record wins
 *   2. Biometric    → fingerprint record wins
 *   3. Approved WFH request → mark wfh present
 *   4. Approved leave → mark on-leave
 *   5. Nothing → mark absent
 *
 * @returns {Object} { action, record }
 */
async function resolveAttendance(user, dateObj) {
  const today = toMidnight(dateObj);
  const existing = await Attendance.findOne({ user_id: user._id, date: today });

  // ── Priority 1: WFH override record already exists → nothing to do ─────
  if (existing?.source === 'wfh') {
    return { action: 'wfh_override', record: existing };
  }

  // ── Priority 2: Biometric record exists + user is NOT on WFH override ──
  if (existing?.source === 'fingerprint' && !await isWfhOverrideActive(user)) {
    return { action: 'biometric', record: existing };
  }

  // ── Priority 3: WFH override active but no clock-in yet → mark absent ──
  if (await isWfhOverrideActive(user) && !existing) {
    const absent = await Attendance.findOneAndUpdate(
      { user_id: user._id, date: today },
      { $setOnInsert: { user_id: user._id, date: today, clock_in: today, status: 'absent', source: 'wfh', work_mode: 'wfh', is_override: true } },
      { upsert: true, new: true }
    );
    return { action: 'wfh_override_absent', record: absent };
  }

  // ── Priority 4: Approved WFH request ───────────────────────────────────
  const wfhReq = await getApprovedWfhRequest(user._id, today);
  if (wfhReq && !existing) {
    // Mark WFH present if policy allows (employee must still clock in)
    return { action: 'wfh_request_pending_clockin', record: null };
  }

  // ── Priority 5: Approved leave ─────────────────────────────────────────
  const leave = await getApprovedLeave(user._id, today);
  if (leave && !existing) {
    const rec = await Attendance.findOneAndUpdate(
      { user_id: user._id, date: today },
      { $setOnInsert: { user_id: user._id, date: today, clock_in: today, status: 'on-leave', source: 'manual' } },
      { upsert: true, new: true }
    );
    return { action: 'on_leave', record: rec };
  }

  // ── Priority 6: Absent ─────────────────────────────────────────────────
  if (!existing) {
    const policy = await getActivePolicy();
    const { isNonWorkingDay } = isHolidayOrWeekend(today, policy);
    if (isNonWorkingDay) {
      return { action: 'non_working_day', record: null };
    }
    const rec = await Attendance.findOneAndUpdate(
      { user_id: user._id, date: today },
      { $setOnInsert: { user_id: user._id, date: today, clock_in: today, status: 'absent', source: 'manual' } },
      { upsert: true, new: true }
    );
    return { action: 'marked_absent', record: rec };
  }

  return { action: 'existing', record: existing };
}

module.exports = {
  getActivePolicy,
  deriveStatusFromPolicy,
  isHolidayOrWeekend,
  isWfhOverrideActive,
  getApprovedWfhRequest,
  getApprovedLeave,
  wfhClockIn,
  wfhClockOut,
  maybeGenerateCompOff,
  resolveAttendance,
  toMidnight,
  calcHours,
};