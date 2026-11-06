/**
 * controllers/attendanceAppController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only endpoints for the Attendance Admin PWA (admins only, see the routes file). Uses the existing models
 * (User, Attendance, Leave, Policy) and the existing auth — no new collections
 * and no writes. Everything is evaluated against the ACTIVE Policy, so changing
 * work hours / grace / half-day / weekly offs / holidays in settings is
 * reflected immediately.
 *
 * Day handling: all calendar days are IST days ("YYYY-MM-DD"). Attendance.date
 * is stored at IST midnight by the attendance controller but at server-local
 * midnight by the eSSL controller, so records are matched by IST day range
 * rather than by exact date — both kinds are found.
 *
 * Mount in routes/Index.js:  router.use("/attendance-app", require("./attendanceAppRoutes"));
 */

const mongoose   = require("mongoose");
const User       = require("../models/users");
const Attendance = require("../models/attendance");
const Leave      = require("../models/leave");
const Policy     = require("../models/policy");
const UnmatchedPunch = require("../models/unmatchedPunch");

const IST = 5.5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const istYmd     = (d) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const istMinutes = (d) => { const x = new Date(new Date(d).getTime() + IST); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const dayStart   = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) - IST); // instant of IST midnight
const addDays    = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday    = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const toMin      = (s, d) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || d)); return m ? +m[1] * 60 + +m[2] : toMin(d, "09:00"); };
const round2     = (n) => Math.round(n * 100) / 100;
const todayIst   = () => istYmd(new Date());
const isStaff    = (u) => u.role === "admin" || u.role === "manager";

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (res, err) => {
  if (!err.status) console.error("[attendance-app]", err);
  return res.status(err.status || 500).json({ success: false, message: err.status ? err.message : "Internal server error" });
};
const parseYmd = (s, name) => {
  if (!YMD.test(String(s || "")) || istYmd(dayStart(s)) !== s) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return s;
};

// ─── Policy ──────────────────────────────────────────────────────────────────
async function loadPolicy() {
  let p = await Policy.findOne({ is_active: true }).sort({ createdAt: -1 }).lean();
  if (!p) p = (await Policy.create({ is_active: true })).toObject();
  const start = toMin(p.work_start_time, "09:00");
  const end = toMin(p.work_end_time, "18:00");
  return {
    raw: p,
    lateAfter: start + (p.late_threshold_minutes ?? 15),
    earlyBefore: end - (p.early_logout_grace_minutes ?? 0),
    halfDay: p.half_day_hours ?? 4,
    fullDay: p.full_day_hours ?? 8,
    weeklyOffs: p.weekly_offs ?? [0, 6],
    holidays: new Map((p.holidays || []).map((h) => [istYmd(h.date), h.name])),
    clockOffset: Number(p.device_clock_offset_minutes) || 0,
  };
}

// ─── One day for one person ──────────────────────────────────────────────────
const SUMMARY_USER = "name email department designation role status employee_id fingerprint_id work_mode joining_date createdAt";

function punchesOf(rec) {
  if (rec.raw_logs?.length) return rec.raw_logs.map((l) => l.time).filter(Boolean).sort((a, b) => a - b);
  return [rec.clock_in, ...(rec.breaks || []).flatMap((b) => [b.start, b.end]), rec.clock_out].filter(Boolean);
}

function evaluate(rec, ymd, pol, today) {
  if (rec.no_times) rec = { ...rec, clock_in: null, clock_out: null, hours_worked: null };
  const off = pol.weeklyOffs.includes(weekday(ymd)) || pol.holidays.has(ymd);
  const inProgress = ymd === today && !rec.clock_out;
  let hours = rec.hours_worked;
  if (hours == null && rec.clock_in && rec.clock_out) {
    hours = Math.max(0, (new Date(rec.clock_out) - new Date(rec.clock_in)) / 36e5 - (rec.break_minutes || 0) / 60);
  }
  hours = hours == null ? null : round2(hours);
  const lateBy = rec.clock_in ? Math.max(0, istMinutes(rec.clock_in) - pol.lateAfter) : 0;

  let status = rec.status || "present";
  // Days an admin marked keep their status. "absent" / "on-leave" are kept too;
  // everything else follows the policy.
  if (!rec.admin_locked && !["absent", "on-leave"].includes(status) && rec.clock_in) {
    if (off) status = "present";
    else if (hours != null && hours < pol.halfDay && !inProgress) status = "half-day";
    else if (lateBy > 0) status = "late";
    else status = "present";
  }
  return {
    date: ymd,
    status,
    record_id: rec._id,
    clock_in: rec.clock_in || null,
    clock_out: rec.clock_out || null,
    hours_worked: hours,
    break_minutes: rec.break_minutes || 0,
    late_by_minutes: !off && status === "late" ? lateBy : 0,
    early_logout: Boolean(rec.clock_out && !off && istMinutes(rec.clock_out) < pol.earlyBefore),
    overtime_hours: hours != null && hours > pol.fullDay ? round2(hours - pol.fullDay) : 0,
    in_progress: inProgress,
    off_day: off,
    holiday: pol.holidays.get(ymd) || null,
    source: rec.source || "manual",
    punches: punchesOf(rec),
    punch_details: (rec.raw_logs || []).map((l) => ({ time: l.time, correction_minutes: Number(l.clock_offset_applied) || 0 })).sort((a, b) => new Date(a.time) - new Date(b.time)),
    uncorrected_punches: pol.clockOffset ? (rec.raw_logs || []).filter((l) => !(Number(l.clock_offset_applied) || 0)).length : 0,
    split_records: rec.split_records || 1,
    stored_status: rec.status,
    ...adminInfo(rec),
  };
}

/**
 * Resolves every day in [from, to] (capped at today) for one person:
 * record → evaluated; else approved leave → on-leave; else holiday; else
 * passed working day since joining → absent. Weekly offs without a record are omitted.
 */
function resolveDays(user, from, to, recsByDay, leaves, pol) {
  const today = todayIst();
  const joined = istYmd(user.joining_date || user.createdAt || dayStart(from));
  const out = [];
  for (let d = from; d <= to && d <= today; d = addDays(d, 1)) {
    const rec = recsByDay.get(d);
    const leave = leaves.find((l) => istYmd(l.from_date) <= d && d <= istYmd(l.to_date));
    const off = pol.weeklyOffs.includes(weekday(d)) || pol.holidays.has(d);
    if (rec && (rec.clock_in || !leave)) {
      const e = evaluate(rec, d, pol, today);
      if (leave && !e.clock_in) { e.status = "on-leave"; }
      if (leave) e.leave_type = leave.leave_type;
      out.push(e);
    } else if (leave && !off) {
      out.push({ date: d, status: "on-leave", leave_type: leave.leave_type, leave_id: leave._id, synthetic: true, punches: [] });
    } else if (pol.holidays.has(d)) {
      out.push({ date: d, status: "holiday", holiday: pol.holidays.get(d), synthetic: true, punches: [] });
    } else if (!off && d < today && d >= joined) {
      out.push({ date: d, status: "absent", synthetic: true, note: "No punch recorded", punches: [] });
    }
  }
  return out.reverse(); // newest first
}

async function loadRange(userIds, from, to) {
  const [recs, leaves] = await Promise.all([
    Attendance.find({ user_id: { $in: userIds }, date: { $gte: dayStart(from), $lt: new Date(dayStart(to).getTime() + DAY) } }).lean(),
    Leave.find({ user_id: { $in: userIds }, status: "approved", from_date: { $lte: new Date(dayStart(to).getTime() + DAY) }, to_date: { $gte: new Date(dayStart(from).getTime() - DAY) } }).lean(),
  ]);
  // Group each person's records by IST day. A day can be split over several
  // records (old/new date format, or app + machine): combine them, then work
  // out login/logout/hours from ALL the punches, so a punch-out saved in a
  // second record is never shown as "missing".
  const groups = new Map(); // userId -> Map(ymd -> [records])
  for (const r of recs) {
    const k = String(r.user_id), d = istYmd(r.clock_in && !r.no_times ? r.clock_in : r.date);
    if (!groups.has(k)) groups.set(k, new Map());
    if (!groups.get(k).has(d)) groups.get(k).set(d, []);
    groups.get(k).get(d).push(r);
  }
  const recMap = new Map();
  for (const [k, byDay] of groups) {
    const m = new Map();
    for (const [d, list] of byDay) m.set(d, combineDay(list));
    recMap.set(k, m);
  }
  const leaveMap = new Map();
  for (const l of leaves) {
    const k = String(l.user_id);
    if (!leaveMap.has(k)) leaveMap.set(k, []);
    leaveMap.get(k).push(l);
  }
  return { recMap, leaveMap };
}

function combineDay(list) {
  const score = (r) => (r.admin_locked ? 8 : 0) + (r.raw_logs?.length ? 4 : 0) + (r.clock_out ? 2 : 0) + (r.clock_in ? 1 : 0);
  const base = [...list].sort((a, b) => score(b) - score(a))[0];
  const logs = list.flatMap((r) => r.raw_logs || []);
  const rec = { ...base, raw_logs: logs, split_records: list.length };
  if (rec.admin_locked || !logs.length) return rec; // admin's marking / app clock-in: as saved
  const { distinctPunches } = require("../services/attendanceRepair");
  const { deriveFromDistinct } = require("./EsslController")._internals;
  const { all, distinct } = distinctPunches(logs);
  if (!distinct.length) return rec;
  const d = deriveFromDistinct(distinct, new Date()); // past days: the last punch counts as logout
  return { ...rec, raw_logs: all, clock_in: d.clock_in, clock_out: d.clock_out, hours_worked: d.hours_worked, break_minutes: d.break_minutes };
}

function summarise(days) {
  const s = { wfh_days: 0, working_days: 0, present: 0, late: 0, half_day: 0, leave: 0, absent: 0, holidays: 0, worked_off_days: 0,
    total_hours: 0, overtime_hours: 0, early_logouts: 0, missing_logouts: 0, avg_login: null, avg_logout: null };
  const ins = [], outs = [];
  const today = todayIst();
  for (const d of days) {
    if (d.work_from_home) s.wfh_days++;
    if (d.clock_in) ins.push(istMinutes(d.clock_in));
    if (d.clock_out) outs.push(istMinutes(d.clock_out));
    s.total_hours += d.hours_worked || 0;
    s.overtime_hours += d.overtime_hours || 0;
    if (d.early_logout) s.early_logouts++;
    if (d.clock_in && !d.clock_out && d.date < today) s.missing_logouts++;
    if (d.status === "holiday") { s.holidays++; continue; }
    if (d.off_day) { if (d.clock_in) s.worked_off_days++; continue; }
    s.working_days++;
    if (d.status === "present") s.present++;
    else if (d.status === "late") { s.present++; s.late++; }
    else if (d.status === "half-day") s.half_day++;
    else if (d.status === "on-leave") s.leave++;
    else if (d.status === "absent") s.absent++;
  }
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  s.avg_login = avg(ins); s.avg_logout = avg(outs);
  s.total_hours = round2(s.total_hours); s.overtime_hours = round2(s.overtime_hours);
  const expected = s.working_days - s.leave;
  s.attendance_pct = expected > 0 ? Math.round(((s.present + s.half_day * 0.5) / expected) * 1000) / 10 : null;
  return s;
}

const adminInfo = (rec) => ({
  remark: rec.remark || "",
  remark_by: rec.remark_by_name || null,
  remark_at: rec.remark_at || null,
  admin_locked: Boolean(rec.admin_locked),
  marked_by: rec.marked_by_name || null,
  marked_at: rec.marked_at || null,
  work_from_home: rec.source === "wfh",
});

const policySummary = (pol) => ({
  work_start_time: pol.raw.work_start_time, work_end_time: pol.raw.work_end_time,
  late_after_minutes: pol.lateAfter, early_before_minutes: pol.earlyBefore,
  half_day_hours: pol.halfDay, full_day_hours: pol.fullDay, weekly_offs: pol.weeklyOffs,
});

// ─── Handlers ────────────────────────────────────────────────────────────────

// GET /api/attendance-app/users — everyone, for pickers and the day view
const listUsers = async (req, res) => {
  try {
    const users = await User.find({}).select(SUMMARY_USER).sort({ name: 1 }).lean();
    res.json({ success: true, data: users });
  } catch (e) { fail(res, e); }
};

// GET /api/attendance-app/day?date=YYYY-MM-DD  (admin, manager)
const getDay = async (req, res) => {
  try {
    const date = parseYmd(req.query.date || todayIst(), "date");
    const pol = await loadPolicy();
    const users = await User.find({ status: { $ne: "inactive" }, role: { $ne: "admin" } }).select(SUMMARY_USER).sort({ name: 1 }).lean();
    const { recMap, leaveMap } = await loadRange(users.map((u) => u._id), date, date);
    const off = pol.weeklyOffs.includes(weekday(date)) || pol.holidays.has(date);
    const today = todayIst();
    const rows = [];
    for (const u of users) {
      const rec = recMap.get(String(u._id))?.get(date);
      const leave = (leaveMap.get(String(u._id)) || []).find((l) => istYmd(l.from_date) <= date && date <= istYmd(l.to_date));
      let day;
      if (rec) day = evaluate(rec, date, pol, today);
      else if (leave && !off) day = { status: "on-leave", leave_type: leave.leave_type, synthetic: true };
      else if (off) continue; // nobody is expected on a weekly off / holiday
      else if (date > today) continue;
      else day = { status: date === today ? "not-marked" : "absent", synthetic: true };
      rows.push({ user: u, ...day, date });
    }
    res.json({ success: true, date, weekly_off: pol.weeklyOffs.includes(weekday(date)), holiday: pol.holidays.get(date) || null,
      policy: policySummary(pol), data: rows });
  } catch (e) { fail(res, e); }
};

async function timelineFor(req, res, userId) {
  const today = todayIst();
  const from = parseYmd(req.query.from || `${today.slice(0, 7)}-01`, "from");
  const to = parseYmd(req.query.to || today, "to");
  if (from > to) throw new HttpError(400, "from must be on or before to");
  if (Date.parse(to) - Date.parse(from) > 400 * DAY) throw new HttpError(400, "Pick a range of at most about a year");
  const user = await User.findById(userId).select(SUMMARY_USER).lean();
  if (!user) throw new HttpError(404, "User not found");
  const pol = await loadPolicy();
  const { recMap, leaveMap } = await loadRange([user._id], from, to);
  const days = resolveDays(user, from, to, recMap.get(String(user._id)) || new Map(), leaveMap.get(String(user._id)) || [], pol);
  res.json({ success: true, user, from, to, policy: policySummary(pol), summary: summarise(days), data: days });
}

// GET /api/attendance-app/user/:id?from=&to=  (admin, manager)
const getUserTimeline = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, "Invalid user id");
    await timelineFor(req, res, req.params.id);
  } catch (e) { fail(res, e); }
};

// GET /api/attendance-app/register?month=YYYY-MM  (admin, manager)
const getRegister = async (req, res) => {
  try {
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || todayIst().slice(0, 7)));
    if (!m || +m[2] < 1 || +m[2] > 12) throw new HttpError(400, "month must be YYYY-MM");
    const from = `${m[1]}-${m[2]}-01`;
    const to = new Date(Date.UTC(+m[1], +m[2], 0)).toISOString().slice(0, 10);
    const pol = await loadPolicy();
    const users = await User.find({ status: { $ne: "inactive" }, role: { $ne: "admin" } }).select(SUMMARY_USER).sort({ name: 1 }).lean();
    const { recMap, leaveMap } = await loadRange(users.map((u) => u._id), from, to);
    const data = users.map((u) => ({
      user: u,
      ...summarise(resolveDays(u, from, to, recMap.get(String(u._id)) || new Map(), leaveMap.get(String(u._id)) || [], pol)),
    }));
    let working = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) if (!pol.weeklyOffs.includes(weekday(d)) && !pol.holidays.has(d)) working++;
    const holidays = [...pol.holidays].filter(([d]) => d >= from && d <= to).map(([date, name]) => ({ date, name }));
    res.json({ success: true, month: `${m[1]}-${m[2]}`, working_days_in_month: working, holidays, policy: policySummary(pol), data });
  } catch (e) { fail(res, e); }
};

// GET /api/attendance-app/leave-balance?user_id=&year=
// Allowance per type from Policy.leave_types (allowed_per_year; 0 on an unpaid type = no limit).
const getLeaveBalance = async (req, res) => {
  try {
    const userId = req.query.user_id || req.user._id;
    if (String(userId) !== String(req.user._id) && !isStaff(req.user)) throw new HttpError(403, "Not authorised");
    if (!mongoose.Types.ObjectId.isValid(userId)) throw new HttpError(400, "Invalid user id");
    const year = parseInt(req.query.year, 10) || +todayIst().slice(0, 4);
    const pol = await loadPolicy();
    const leaves = await Leave.find({
      user_id: userId, status: { $in: ["approved", "pending"] },
      from_date: { $gte: dayStart(`${year}-01-01`), $lt: dayStart(`${year + 1}-01-01`) },
    }).lean();
    const data = (pol.raw.leave_types || []).map((t) => {
      const mine = leaves.filter((l) => l.leave_type === t.type);
      const sum = (s) => mine.filter((l) => l.status === s).reduce((a, l) => a + (l.days || 0), 0);
      const used = sum("approved"), pending = sum("pending");
      const allowed = !t.allowed_per_year && !t.is_paid ? null : (t.allowed_per_year || 0);
      return { type: t.type, label: t.label, is_paid: t.is_paid, allowed, used, pending,
        remaining: allowed == null ? null : Math.max(0, allowed - used - pending) };
    });
    res.json({ success: true, year, data });
  } catch (e) { fail(res, e); }
};

// ─── Admin edits ─────────────────────────────────────────────────────────────

// PATCH /api/attendance-app/user/:id/ids   { employee_id?, fingerprint_id? }
// Empty string clears a value. Both must be unique across users.
const setUserIds = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new HttpError(400, "Invalid user id");
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(404, "User not found");
    for (const field of ["employee_id", "fingerprint_id"]) {
      if (req.body?.[field] === undefined) continue;
      const value = String(req.body[field] ?? "").trim();
      if (value.length > 40) throw new HttpError(400, `${field} is too long`);
      if (value) {
        const clash = await User.findOne({ [field]: value, _id: { $ne: user._id } }).select("name").lean();
        if (clash) throw new HttpError(409, `${field === "employee_id" ? "Employee ID" : "Device ID"} "${value}" already belongs to ${clash.name}`);
      }
      user[field] = value || (field === "employee_id" ? undefined : null);
    }
    await user.save({ validateModifiedOnly: true });
    const imported = await importForUser(user);
    const data = await User.findById(user._id).select(SUMMARY_USER).lean();
    res.json({ success: true, data, imported });
  } catch (e) { fail(res, e); }
};

// Imports kept (unassigned) machine punches that now belong to this user.
async function importForUser(user) {
  const { importUnmatchedPunches } = require("./EsslController"); // lazy: avoids a load cycle
  const out = [];
  for (const id of [user.fingerprint_id, user.employee_id].filter(Boolean)) {
    // A Device ID that matches someone's fingerprint_id belongs to them, not to an employee_id match
    if (id === user.employee_id && id !== user.fingerprint_id && await User.exists({ fingerprint_id: id, _id: { $ne: user._id } })) continue;
    const r = await importUnmatchedPunches(id, user);
    if (r.punches) out.push({ device_id: id, ...r });
  }
  return out;
}

const cleanId = (v) => {
  const value = String(v ?? "").trim();
  if (value.length > 40) throw new HttpError(400, `"${value.slice(0, 12)}…" is too long (max 40 characters)`);
  return value;
};

// GET /api/attendance-app/ids
// Everyone's Employee ID and Device ID, plus machine IDs that have punches but no owner.
const listIds = async (req, res) => {
  try {
    const [users, unassigned] = await Promise.all([
      User.find({}).select("name email department designation role status employee_id fingerprint_id").sort({ status: 1, name: 1 }).lean(),
      UnmatchedPunch.find({}).select("device_id count first_seen last_seen punches").sort({ last_seen: -1 }).lean(),
    ]);
    res.json({
      success: true,
      data: users,
      unassigned: unassigned.map((u) => ({ device_id: u.device_id, punches: u.punches.length, count: u.count, first_seen: u.first_seen, last_seen: u.last_seen })),
    });
  } catch (e) { fail(res, e); }
};

// PUT /api/attendance-app/ids   { changes: [{ user_id, employee_id?, fingerprint_id? }] }
// Saves many people at once. Uniqueness is checked on the final result, so two
// people's IDs can be swapped in one save. "" clears a value.
const saveIds = async (req, res) => {
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length) throw new HttpError(400, "No changes to save");
    if (changes.length > 1000) throw new HttpError(400, "Too many changes at once");
    const all = await User.find({}).select("name employee_id fingerprint_id").lean();
    const byId = new Map(all.map((u) => [String(u._id), { ...u }]));
    const touched = new Map();
    for (const c of changes) {
      const u = byId.get(String(c.user_id));
      if (!u) throw new HttpError(404, `User ${c.user_id} not found`);
      for (const f of ["employee_id", "fingerprint_id"]) if (c[f] !== undefined) u[f] = cleanId(c[f]) || null;
      touched.set(String(u._id), u);
    }
    // Final state must be unique per field
    for (const [f, label] of [["employee_id", "Employee ID"], ["fingerprint_id", "Device ID"]]) {
      const seen = new Map();
      for (const u of byId.values()) {
        if (!u[f]) continue;
        if (seen.has(u[f])) throw new HttpError(409, `${label} "${u[f]}" is given to both ${seen.get(u[f])} and ${u.name}`);
        seen.set(u[f], u.name);
      }
    }
    // Two steps so swaps don't trip the unique index: clear, then set.
    const ids = [...touched.keys()];
    await User.updateMany({ _id: { $in: ids } }, { $unset: { employee_id: "" }, $set: { fingerprint_id: null } });
    for (const u of touched.values()) {
      const set = { fingerprint_id: u.fingerprint_id || null };
      if (u.employee_id) set.employee_id = u.employee_id;
      await User.updateOne({ _id: u._id }, { $set: set });
    }
    const imported = [];
    for (const id of ids) {
      const user = await User.findById(id);
      for (const r of await importForUser(user)) imported.push({ ...r, user: user.name });
    }
    res.json({ success: true, updated: ids.length, imported });
  } catch (e) { fail(res, e); }
};

// DELETE /api/attendance-app/ids/unassigned/:deviceId — discard kept punches (e.g. test enrolments)
const discardUnassigned = async (req, res) => {
  try {
    const r = await UnmatchedPunch.deleteOne({ device_id: String(req.params.deviceId).trim() });
    if (!r.deletedCount) throw new HttpError(404, "Nothing kept for that Device ID");
    res.json({ success: true });
  } catch (e) { fail(res, e); }
};

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const atIst = (ymd, hhmm) => {
  const m = HHMM.exec(String(hhmm));
  if (!m) throw new HttpError(400, "Times must look like 09:30");
  return new Date(dayStart(ymd).getTime() + (+m[1] * 60 + +m[2]) * 60000);
};

// PUT /api/attendance-app/record
// { user_id, date: "YYYY-MM-DD", work_from_home?, status?, clock_in?, clock_out?, remark? }
//   status: "auto" (from the times and the policy) | present | late | half-day | absent | on-leave
//   clock_in / clock_out: "HH:mm" IST, or "" to clear
//   remark: text, or "" to remove it
// Changing work from home, status or times locks the day (fingerprint punches
// are still logged but no longer change it). A remark alone doesn't lock.
const saveDayRecord = async (req, res) => {
  try {
    const b = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(b.user_id)) throw new HttpError(400, "Invalid user id");
    const date = parseYmd(b.date, "date");
    if (date > todayIst()) throw new HttpError(400, "You can't mark a future day");
    const user = await User.findById(b.user_id).select("name").lean();
    if (!user) throw new HttpError(404, "User not found");

    const range = { $gte: dayStart(date), $lt: new Date(dayStart(date).getTime() + DAY) };
    let rec = await Attendance.findOne({ user_id: b.user_id, date: range }).sort({ clock_out: -1, clock_in: -1 });
    const isNew = !rec;
    if (!rec) rec = new Attendance({ user_id: b.user_id, date: dayStart(date), source: "manual", status: "present" });

    const marking = ["work_from_home", "status", "clock_in", "clock_out"].some((k) => b[k] !== undefined);
    if (rec.no_times) { rec.clock_in = undefined; rec.clock_out = null; }
    if (b.clock_in !== undefined) rec.clock_in = b.clock_in ? atIst(date, b.clock_in) : undefined;
    if (b.clock_out !== undefined) rec.clock_out = b.clock_out ? atIst(date, b.clock_out) : null;
    if (rec.clock_in && rec.clock_out && rec.clock_out <= rec.clock_in) throw new HttpError(400, "Logout must be after login");
    if (b.clock_in !== undefined || b.clock_out !== undefined) {
      rec.hours_worked = rec.clock_in && rec.clock_out
        ? round2(Math.max(0, (rec.clock_out - rec.clock_in) / 36e5 - (rec.break_minutes || 0) / 60)) : null;
    }
    if (b.work_from_home !== undefined) {
      rec.source = b.work_from_home ? "wfh" : (rec.raw_logs?.length ? "fingerprint" : "manual");
    }
    if (!rec.clock_in) {
      // The schema requires clock_in: a day marked without a login time keeps
      // 00:00 IST there and is flagged no_times so it's never shown as a login.
      rec.clock_in = dayStart(date);
      rec.clock_out = null;
      rec.hours_worked = null;
      rec.no_times = true;
    } else {
      rec.no_times = false;
    }
    if (b.status !== undefined) {
      const allowed = ["auto", "present", "late", "half-day", "absent", "on-leave"];
      if (!allowed.includes(b.status)) throw new HttpError(400, `status must be one of: ${allowed.join(", ")}`);
      if (b.status === "auto") {
        const pol = await loadPolicy();
        rec.status = !rec.no_times ? evaluate({ ...rec.toObject(), admin_locked: false }, date, pol, todayIst()).status
          : rec.source === "wfh" ? "present" : "absent";
      } else rec.status = b.status;
    }
    if (marking) {
      Object.assign(rec, { admin_locked: true, marked_by: req.user._id, marked_by_name: req.user.name, marked_at: new Date() });
    }
    if (b.remark !== undefined) {
      const text = String(b.remark || "").trim().slice(0, 500);
      Object.assign(rec, text
        ? { remark: text, remark_by: req.user._id, remark_by_name: req.user.name, remark_at: new Date() }
        : { remark: "", remark_by: null, remark_by_name: null, remark_at: null });
    }

    await rec.save();
    const pol = await loadPolicy();
    const out = evaluate(rec.toObject(), date, pol, todayIst());
    res.json({ success: true, data: { ...out, created: isNew } });
  } catch (e) {
    if (e.name === "ValidationError") return res.status(400).json({ success: false, message: Object.values(e.errors).map((x) => x.message).join("; ") });
    fail(res, e);
  }
};

// GET /api/attendance-app/data-health — what (if anything) needs repairing
const getDataHealth = async (req, res) => {
  try { res.json({ success: true, data: await require("../services/attendanceRepair").dataHealth({ days: 90 }) }); }
  catch (e) { fail(res, e); }
};

// POST /api/attendance-app/repair { apply?: boolean, correct_clock?: boolean }
// Preview (default) or apply the same repair as scripts/fixAttendanceDates.js.
const repairData = async (req, res) => {
  try {
    const { runRepair } = require("../services/attendanceRepair");
    const r = await runRepair({
      apply: req.body?.apply === true,
      correctClock: req.body?.correct_clock === true,
      args: ["admin-app", req.user.email || String(req.user._id)],
    });
    res.json({ success: true, data: { ...r, backupFile: r.backupFile ? require("path").basename(r.backupFile) : null } });
  } catch (e) { fail(res, e.status ? e : Object.assign(e, { status: 400 })); }
};

// POST /api/attendance-app/repair/undo { backup: "attendance-fix-....json", apply?: boolean }
const undoRepair = async (req, res) => {
  try {
    const name = String(req.body?.backup || "");
    if (!/^attendance-fix-[\w.-]+\.json$/.test(name)) throw new HttpError(400, "Unknown backup file");
    const file = require("path").join(__dirname, "..", "backups", name);
    if (!require("fs").existsSync(file)) throw new HttpError(404, "Backup file not found on the server");
    res.json({ success: true, data: await require("../services/attendanceRepair").restoreBackup(file, { apply: req.body?.apply === true }) });
  } catch (e) { fail(res, e); }
};

module.exports = { getDataHealth, repairData, undoRepair, listIds, saveIds, discardUnassigned, setUserIds, saveDayRecord, listUsers, getDay, getUserTimeline, getRegister, getLeaveBalance,
  _internals: { evaluate, resolveDays, summarise, istYmd, dayStart } };
