/**
 * services/attendanceRules.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE place for two things every attendance writer must agree on:
 *
 * 1. WHICH DAY a record belongs to.
 *    Attendance.date is always the instant of 00:00 IST on that IST calendar day
 *    (e.g. 5 Nov 2026 → 2026-11-04T18:30:00.000Z), whatever timezone the server
 *    runs in. Previously the eSSL controller used d.setHours(0,0,0,0) (server
 *    midnight) and grouped punches by UTC date, so on a UTC/CET server its
 *    records never matched the attendance controller's IST-midnight queries,
 *    and punches before 05:30 IST were filed under the previous day.
 *
 * 2. WHAT STATUS a day gets, from the ACTIVE Policy (not hard-coded 09:15 / 4 h):
 *      weekly off or holiday             → present (nobody is late on a day off)
 *      worked < policy.half_day_hours    → half-day   (only once clock-out is known)
 *      clock-in > work_start + late grace→ late
 *      otherwise                         → present
 *
 * The active policy is cached for 60 s; policyController calls invalidateRules()
 * after every change so edits apply to the next punch immediately.
 */

const Policy = require("../models/policy");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ─── IST calendar helpers (server-timezone independent) ─────────────────────

/** "YYYY-MM-DD" of the IST calendar day that contains instant `d`. */
const istDateKey = (d = new Date()) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Instant of 00:00 IST for a "YYYY-MM-DD" key, or for the IST day containing instant `d`. */
const istDayStart = (d = new Date()) => {
  const key = typeof d === "string" && YMD.test(d) ? d : istDateKey(d);
  return new Date(Date.parse(`${key}T00:00:00Z`) - IST_OFFSET_MS);
};

/** Mongo range matching every record stored anywhere inside that IST day (old and new conventions). */
const istDayRange = (d = new Date()) => {
  const start = istDayStart(d);
  return { $gte: start, $lt: new Date(start.getTime() + DAY_MS) };
};

/** Minutes since 00:00 IST for instant `d`. */
const istMinutes = (d) => {
  const x = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  return x.getUTCHours() * 60 + x.getUTCMinutes();
};

/**
 * node-zklib builds punch times with `new Date(y, m, d, h, mi, s)`, i.e. the
 * device's wall-clock read as SERVER-local time. The device runs on IST, so
 * re-read those wall-clock components as IST. Correct on any server timezone
 * (on an IST server this returns the same instant).
 */
const deviceLocalToInstant = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate(), x.getHours(), x.getMinutes(), x.getSeconds()) - IST_OFFSET_MS);
};

// ─── Policy rules ───────────────────────────────────────────────────────────

const toMin = (s, fallback) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

function toRules(p = {}) {
  const workStartMinutes = toMin(p.work_start_time, 9 * 60);
  const workEndMinutes = toMin(p.work_end_time, 18 * 60);
  const lateGraceMinutes = p.late_threshold_minutes ?? 15;
  return {
    workStartMinutes,
    workEndMinutes,
    lateGraceMinutes,
    lateAfterMinutes: workStartMinutes + lateGraceMinutes,
    earlyBeforeMinutes: workEndMinutes - (p.early_logout_grace_minutes ?? 0),
    halfDayHours: p.half_day_hours ?? 4,
    fullDayHours: p.full_day_hours ?? 8,
    weeklyOffs: Array.isArray(p.weekly_offs) ? p.weekly_offs : [0, 6],
    holidays: new Set((p.holidays || []).map((h) => istDateKey(h.date))),
    deviceClockOffsetMinutes: Number(p.device_clock_offset_minutes) || 0,
  };
}

/**
 * Real time of a punch from the fingerprint machine. The machine's own clock
 * can drift; Policy.device_clock_offset_minutes says by how much (positive =
 * machine is behind, so minutes are added).
 */
const correctDeviceTime = (instant, rules = getRules()) =>
  new Date(new Date(instant).getTime() + (rules.deviceClockOffsetMinutes || 0) * 60 * 1000);

const TTL_MS = 60 * 1000;
let cache = null;
let cachedAt = 0;

/** Loads (and caches) the active policy's rules. Never throws. */
async function loadRules(force = false) {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const p = await Policy.findOne({ is_active: true }).sort({ createdAt: -1 }).lean();
    cache = toRules(p || {});
    cachedAt = Date.now();
  } catch (err) {
    console.error("[attendanceRules] could not load policy, using last known rules:", err.message);
    if (!cache) cache = toRules({});
  }
  return cache;
}

/** Last loaded rules (defaults until the first load). Call loadRules() first in async code. */
const getRules = () => cache || toRules({});

/** Call after creating/updating the policy or its holidays. */
const invalidateRules = () => { cachedAt = 0; };

/** Is this IST day a weekly off or a policy holiday? Accepts a "YYYY-MM-DD" key or an instant. */
function isOffDay(dayOrInstant, rules = getRules()) {
  const key = typeof dayOrInstant === "string" && YMD.test(dayOrInstant) ? dayOrInstant : istDateKey(dayOrInstant);
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return rules.weeklyOffs.includes(weekday) || rules.holidays.has(key);
}

/**
 * Status for a worked day. `hoursWorked` is null until the day's clock-out is
 * known, so a day in progress is never called a half-day.
 */
function deriveStatus(clockIn, hoursWorked = null, rules = getRules()) {
  if (isOffDay(clockIn, rules)) return "present";
  if (hoursWorked != null && hoursWorked < rules.halfDayHours) return "half-day";
  if (istMinutes(clockIn) > rules.lateAfterMinutes) return "late";
  return "present";
}

module.exports = {
  IST_OFFSET_MS,
  DAY_MS,
  istDateKey,
  istDayStart,
  istDayRange,
  istMinutes,
  deviceLocalToInstant,
  correctDeviceTime,
  loadRules,
  getRules,
  invalidateRules,
  isOffDay,
  deriveStatus,
  toRules,
};
