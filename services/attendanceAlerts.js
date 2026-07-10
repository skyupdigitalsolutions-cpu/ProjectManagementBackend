/**
 * services/attendanceAlerts.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Attendance-driven alerts:
 *
 *   1. LOGIN PING       — when an employee clocks in, post their login time to
 *                         Telegram, flagging LATE arrivals.  (real-time)
 *
 *   2. OVERTIME ALERT   — when an employee clocks out having worked more than
 *                         their standard day, notify all admins in-app AND on
 *                         Telegram with the number of extra hours.
 *
 *   3. DAILY DIGEST     — one consolidated Telegram message listing every
 *                         employee's login timing for the day, marking who was
 *                         late and who did overtime. (fired by the cron scheduler)
 *
 * All functions swallow their own errors — attendance saving must never break
 * because a notification failed.
 *
 * ── Relevant ENV VARS (all optional, sensible defaults shown) ─────────────────
 *   WORK_START              "09:00"   scheduled office start time (HH:MM, IST)
 *   LATE_GRACE_MINUTES      15        minutes after start before "late" kicks in
 *   STANDARD_WORK_HOURS     8         fallback daily hours (user.dailyWorkingHours wins)
 *   OVERTIME_INCLUDE_BREAKS "true"    breaks/lunch count as working time (OT = span − 8h).
 *                                     set "false" to subtract breaks before counting OT.
 *   STANDARD_BREAK_MINUTES  60        break subtracted ONLY when INCLUDE_BREAKS=false and
 *                                     no app breaks were logged (e.g. biometric records)
 *   OVERTIME_MIN_MINUTES    15        ignore OT smaller than this (noise filter)
 *   TELEGRAM_LOGIN_PINGS    "true"    set "false" to disable the real-time login ping
 */

const Attendance = require("../models/attendance");
const User = require("../models/users");
const { notifyAdmins } = require("./notify");
const { sendTelegramMessage, isConfigured, escapeHtml } = require("./telegram");

// ─── Config helpers ───────────────────────────────────────────────────────────

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function cfg() {
  const [sh, sm] = String(process.env.WORK_START || "09:00").split(":").map(Number);
  return {
    workStartMinutes: (Number.isFinite(sh) ? sh : 9) * 60 + (Number.isFinite(sm) ? sm : 0),
    lateGrace: num(process.env.LATE_GRACE_MINUTES, 15),
    standardHours: num(process.env.STANDARD_WORK_HOURS, 8),
    standardBreakMin: num(process.env.STANDARD_BREAK_MINUTES, 60),
    overtimeMinMinutes: num(process.env.OVERTIME_MIN_MINUTES, 15),
    loginPings: String(process.env.TELEGRAM_LOGIN_PINGS ?? "true").toLowerCase() !== "false",
    // When true (default), lunch/breaks count as working time: overtime is simply
    // (clock-out − clock-in) − standard hours. Set "false" to subtract breaks
    // (app-logged breaks, or STANDARD_BREAK_MINUTES for biometric records).
    includeBreaks: String(process.env.OVERTIME_INCLUDE_BREAKS ?? "true").toLowerCase() !== "false",
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Format a Date as a time-of-day string in IST, e.g. "09:04 AM". */
function fmtTimeIST(date) {
  if (!date) return "—";
  return new Date(date).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

/** Format a full date in IST, e.g. "Fri, 11 Jul 2026". */
function fmtDateIST(date = new Date()) {
  return new Date(date).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

/** Turn a minute count into "1h 26m" / "45m" / "2h". */
function fmtDuration(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h && mm) return `${h}h ${mm}m`;
  if (h) return `${h}h`;
  return `${mm}m`;
}

/** Clock-in minute-of-day computed in IST (so late detection is tz-correct). */
function clockInMinutesIST(clockIn) {
  const parts = new Date(clockIn).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }); // "09:04"
  const [h, m] = parts.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// ─── Core stats ───────────────────────────────────────────────────────────────

/**
 * Compute the work stats for one attendance record.
 * @returns {{
 *   grossHours:number, breakMinutes:number, netHours:number,
 *   thresholdHours:number, extraMinutes:number, isOvertime:boolean,
 *   isLate:boolean, lateByMinutes:number
 * }}
 */
function computeWorkStats(record, user = {}) {
  const c = cfg();
  const thresholdHours = num(user.dailyWorkingHours, c.standardHours);

  // Late? — based on the clock-in time-of-day (IST) vs scheduled start + grace.
  const ciMin = clockInMinutesIST(record.clock_in);
  const lateByMinutes = Math.max(0, ciMin - c.workStartMinutes);
  const isLate = ciMin > c.workStartMinutes + c.lateGrace;

  const grossHours = num(record.hours_worked, 0);

  // Overtime basis. By default lunch/breaks count as working time, so we use
  // the full clock-in→clock-out span. If OVERTIME_INCLUDE_BREAKS=false, subtract
  // app-logged breaks (or the standard break for biometric records with none).
  const appBreak = num(record.break_minutes, 0);
  const breakMinutes = c.includeBreaks ? 0 : (appBreak > 0 ? appBreak : c.standardBreakMin);

  const netHours = record.clock_out ? Math.max(0, grossHours - breakMinutes / 60) : 0;
  const extraMinutes = record.clock_out
    ? Math.round((netHours - thresholdHours) * 60)
    : 0;
  const isOvertime = record.clock_out && extraMinutes >= c.overtimeMinMinutes;

  return {
    grossHours,
    breakMinutes,
    netHours,
    thresholdHours,
    extraMinutes,
    isOvertime,
    isLate,
    lateByMinutes,
  };
}

// ─── 1. LOGIN PING (real-time) ────────────────────────────────────────────────

/**
 * Fire the real-time "employee clocked in" Telegram ping exactly once per
 * attendance record. Safe to call repeatedly (guarded by login_notified).
 *
 * @param {Object} record  saved Attendance document
 * @param {Object} user    User doc (needs name, department, dailyWorkingHours)
 */
async function handleClockInAlert(record, user) {
  try {
    const c = cfg();
    if (!c.loginPings || !isConfigured()) return;
    if (!record || record.login_notified) return;
    if (record.status === "absent" || record.status === "on-leave") return;

    const stats = computeWorkStats(record, user);
    const name = escapeHtml(user?.name || "Unknown");
    const dept = user?.department ? ` · ${escapeHtml(user.department)}` : "";
    const src =
      record.source === "fingerprint" ? " 🔐" :
      record.source === "wfh" ? " 🏠" : "";

    const lateTag = stats.isLate
      ? `  <b>⚠️ LATE</b> (by ${fmtDuration(stats.lateByMinutes)})`
      : "";

    const text =
      `🟢 <b>${name}</b>${dept}${src}\n` +
      `Clocked in at <b>${fmtTimeIST(record.clock_in)}</b>${lateTag}`;

    const r = await sendTelegramMessage(text);
    // Only latch the flag if it actually went out (or Telegram is misconfigured
    // and we shouldn't keep retrying forever).
    if (r.ok || r.skipped) {
      await Attendance.updateOne({ _id: record._id }, { $set: { login_notified: true } });
    }
  } catch (err) {
    console.error("[attendanceAlerts] handleClockInAlert failed:", err.message);
  }
}

// ─── 2. OVERTIME ALERT (admin in-app + Telegram) ──────────────────────────────

/**
 * When a record has a clock-out, check for overtime and, if the employee
 * worked more than their standard day, alert all admins (in-app) and post to
 * Telegram. Fires once per record (guarded by overtime_alerted).
 *
 * @param {Object} record  saved Attendance document (must be clocked out)
 * @param {Object} user    User doc
 */
async function handleClockOutAlert(record, user) {
  try {
    if (!record || !record.clock_out || record.overtime_alerted) return;

    const stats = computeWorkStats(record, user);
    if (!stats.isOvertime) return;

    const name = user?.name || "Unknown";
    const dept = user?.department || "—";
    const extraStr = fmtDuration(stats.extraMinutes);
    const inTime = fmtTimeIST(record.clock_in);
    const outTime = fmtTimeIST(record.clock_out);
    const workedStr = fmtDuration(Math.round(stats.netHours * 60));

    // ── In-app notification to every admin ──────────────────────────────────
    await notifyAdmins({
      message:
        `⏱️ Overtime: ${name} (${dept}) worked ${workedStr} today ` +
        `(${extraStr} over the ${stats.thresholdHours}h day). ` +
        `In ${inTime} · Out ${outTime}.`,
      type: "system_alert",
      sender_id: user?._id || null,
    });

    // ── Telegram ────────────────────────────────────────────────────────────
    if (isConfigured()) {
      const text =
        `⏱️ <b>Overtime alert</b>\n` +
        `<b>${escapeHtml(name)}</b> · ${escapeHtml(dept)}\n` +
        `Worked <b>${workedStr}</b> — <b>${extraStr} extra</b> ` +
        `(standard ${stats.thresholdHours}h)\n` +
        `In ${inTime} · Out ${outTime}`;
      await sendTelegramMessage(text);
    }

    await Attendance.updateOne({ _id: record._id }, { $set: { overtime_alerted: true } });
  } catch (err) {
    console.error("[attendanceAlerts] handleClockOutAlert failed:", err.message);
  }
}

// ─── 3. DAILY DIGEST (all employees' login timings) ──────────────────────────

/** Midnight (00:00) for the given date, server-local. */
function toMidnight(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Build and send one consolidated Telegram message with every employee's login
 * timing for `dateObj` (default today): shows clock-in time, marks LATE, shows
 * hours worked, and flags overtime with the extra hours.
 *
 * @param {Date} [dateObj]  the day to report on (default: today)
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, counts?:object}>}
 */
async function sendDailyAttendanceDigest(dateObj = new Date()) {
  try {
    if (!isConfigured()) {
      console.warn("[attendanceAlerts] Telegram not configured — digest skipped");
      return { ok: false, skipped: true };
    }

    const day = toMidnight(dateObj);
    const records = await Attendance.find({ date: day })
      .populate("user_id", "name department dailyWorkingHours role status")
      .sort({ clock_in: 1 })
      .lean();

    const header = `📋 <b>Daily Attendance</b> — ${fmtDateIST(day)}`;

    if (!records.length) {
      await sendTelegramMessage(`${header}\n\nNo attendance recorded yet.`);
      return { ok: true, counts: { total: 0 } };
    }

    const counts = { present: 0, late: 0, overtime: 0, absent: 0, onLeave: 0 };
    const lines = [];
    const absentNames = [];

    for (const rec of records) {
      const user = rec.user_id || {};
      const name = escapeHtml(user.name || "Unknown");

      if (rec.status === "absent") {
        counts.absent++;
        absentNames.push(name);
        continue;
      }
      if (rec.status === "on-leave") {
        counts.onLeave++;
        continue;
      }

      const stats = computeWorkStats(rec, user);
      counts.present++;
      if (stats.isLate) counts.late++;
      if (stats.isOvertime) counts.overtime++;

      const dot = stats.isLate ? "🟡" : "🟢";
      const lateTag = stats.isLate ? `  ⚠️ <b>LATE</b> (${fmtDuration(stats.lateByMinutes)})` : "";

      let tail;
      if (rec.clock_out) {
        const workedStr = fmtDuration(Math.round(stats.netHours * 60));
        const otTag = stats.isOvertime ? `  ⏱️ <b>+${fmtDuration(stats.extraMinutes)} OT</b>` : "";
        tail = `out ${fmtTimeIST(rec.clock_out)} · ${workedStr}${otTag}`;
      } else {
        tail = "still clocked in";
      }

      lines.push(
        `${dot} <b>${name}</b> — in ${fmtTimeIST(rec.clock_in)}${lateTag}\n     ${tail}`
      );
    }

    let body = `${header}\n\n`;
    body += lines.length ? lines.join("\n") : "No one clocked in.";
    if (absentNames.length) {
      body += `\n\n🔴 Absent: ${absentNames.join(", ")}`;
    }
    body +=
      `\n\n<i>Summary: ${counts.present} present · ${counts.late} late · ` +
      `${counts.overtime} OT · ${counts.absent} absent</i>`;

    const r = await sendTelegramMessage(body);
    return { ok: r.ok, error: r.error, counts };
  } catch (err) {
    console.error("[attendanceAlerts] sendDailyAttendanceDigest failed:", err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  computeWorkStats,
  handleClockInAlert,
  handleClockOutAlert,
  sendDailyAttendanceDigest,
  // exported for testing/formatting reuse
  fmtTimeIST,
  fmtDuration,
};