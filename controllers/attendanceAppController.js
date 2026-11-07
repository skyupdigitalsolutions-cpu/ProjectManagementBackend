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

// Who appears in the day view and the monthly register: everyone active except
// admins, unless the admin has a Device ID (they punch in like anyone else).
const TRACKED_USERS = {
  status: { $ne: "inactive" },
  $or: [{ role: { $ne: "admin" } }, { fingerprint_id: { $exists: true, $nin: ["", null] } }],
};

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
    const users = await User.find(TRACKED_USERS).select(SUMMARY_USER).sort({ name: 1 }).lean();
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
    const users = await User.find(TRACKED_USERS).select(SUMMARY_USER).sort({ name: 1 }).lean();
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
    if (req.body?.email !== undefined && String(req.body.email || "").trim()) {
      const email = String(req.body.email).trim().toLowerCase();
      if (!EMAIL_RE.test(email) || isPlaceholderEmail(email)) throw new HttpError(400, "Enter a valid email");
      const clash = await User.findOne({ email, _id: { $ne: user._id } }).select("name").lean();
      if (clash) throw new HttpError(409, `Email already used by ${clash.name}`);
      user.email = email;
    }
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || "").trim().slice(0, 100);
      if (!name) throw new HttpError(400, "Name can't be empty");
      user.name = name;
    }
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

// Email is optional. Placeholder
// addresses (from the earlier "no email" option) don't count as an email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isPlaceholderEmail = (e) => /@no-email\.invalid$/i.test(String(e || ""));
const hasRealEmail = (u) => Boolean(u?.email) && EMAIL_RE.test(u.email) && !isPlaceholderEmail(u.email);

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
    const all = await User.find({}).select("name email employee_id fingerprint_id").lean();
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

// ─── Bulk entry ──────────────────────────────────────────────────────────────
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => YMD_RE.test(String(d || "")) && istYmd(dayStart(d)) === d;

// POST /api/attendance-app/holidays/bulk  { items: [{ date: "YYYY-MM-DD", name }], dry_run?: true }
// Adds holidays to the active Policy. A date that's already a holiday is renamed if the name differs.
const bulkHolidays = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw new HttpError(400, "Add at least one holiday");
    if (items.length > 400) throw new HttpError(400, "At most 400 holidays at once");
    const policy = await Policy.findOne({ is_active: true }).sort({ createdAt: -1 });
    if (!policy) throw new HttpError(404, "No active company policy");
    const existing = new Map((policy.holidays || []).map((h) => [istYmd(h.date), h]));
    const seen = new Set();
    const results = items.map((it, index) => {
      const date = String(it.date || "").trim(), name = String(it.name || "").trim().slice(0, 120);
      if (!validDay(date)) return { index, date, name, ok: false, error: "Not a real date (check the day and month)" };
      if (!name) return { index, date, name, ok: false, error: "Holiday name is missing" };
      if (seen.has(date)) return { index, date, name, ok: false, error: "This date is listed twice" };
      seen.add(date);
      const old = existing.get(date);
      if (old && old.name === name) return { index, date, name, ok: false, skipped: true, error: "Already a holiday" };
      return { index, date, name, ok: true, action: old ? `rename "${old.name}"` : "add" };
    });
    const good = results.filter((r) => r.ok);
    if (!req.body?.dry_run && good.length) {
      for (const r of good) {
        const old = existing.get(r.date);
        if (old) old.name = r.name;
        else policy.holidays.push({ date: new Date(`${r.date}T00:00:00Z`), name: r.name });
      }
      policy.holidays.sort((a, b) => a.date - b.date);
      await policy.save();
      require("../services/attendanceRules").invalidateRules();
    }
    res.json({ success: true, data: { saved: req.body?.dry_run ? 0 : good.length, ready: good.length, results } });
  } catch (e) { fail(res, e); }
};

// POST /api/attendance-app/leaves/bulk
// { items: [{ who | user_id, leave_type, from, to, reason? }], dry_run?: true }
//   who: Employee ID, Device ID or email.  leave_type: key (casual) or label (Casual Leave).
// Records approved leave on behalf of employees. Weekly offs and holidays aren't
// counted; a row that overlaps the person's existing pending/approved leave is skipped.
const bulkLeaves = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw new HttpError(400, "Add at least one leave");
    if (items.length > 500) throw new HttpError(400, "At most 500 leave rows at once");
    const pol = await loadPolicy();
    const types = pol.raw.leave_types || [];
    const allowed = new Set(Leave.schema.path("leave_type").enumValues || []);
    const typeOf = (t) => {
      const v = String(t || "").trim().toLowerCase().replace(/\s+leave$/, "");
      const hit = types.find((x) => x.type === v || String(x.label || "").toLowerCase().replace(/\s+leave$/, "") === v);
      const key = hit ? hit.type : v;
      return allowed.has(key) ? { key, label: hit?.label || key } : null;
    };
    const users = await User.find({}).select("name email employee_id fingerprint_id status").lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const byKey = new Map();
    for (const u of users) {
      if (u.employee_id) byKey.set(`e:${String(u.employee_id).trim().toLowerCase()}`, u);
      if (u.fingerprint_id) byKey.set(`d:${String(u.fingerprint_id).trim().toLowerCase()}`, u);
      if (u.email) byKey.set(`m:${u.email.toLowerCase()}`, u);
    }
    const findUser = (it) => {
      if (it.user_id) return byId.get(String(it.user_id));
      const w = String(it.who || "").trim().toLowerCase();
      return byKey.get(`e:${w}`) || byKey.get(`m:${w}`) || byKey.get(`d:${w}`);
    };
    const isOff = (d) => pol.weeklyOffs.includes(weekday(d)) || pol.holidays.has(d);

    const batch = []; // accepted rows so far, to catch overlaps inside the same upload
    const results = [];
    for (const [index, it] of items.entries()) {
      const r = { index, who: it.who || it.user_id, from: it.from, to: it.to || it.from };
      const u = findUser(it);
      const t = typeOf(it.leave_type);
      if (!u) { results.push({ ...r, ok: false, error: `No employee with Employee ID, Device ID or email "${it.who || it.user_id || ""}"` }); continue; }
      r.user = { _id: u._id, name: u.name, employee_id: u.employee_id || null };
      if (u.status === "inactive") { results.push({ ...r, ok: false, error: "This person is inactive" }); continue; }
      if (!t) { results.push({ ...r, ok: false, error: `Unknown leave type "${it.leave_type || ""}" (use ${types.map((x) => x.type).join(", ")})` }); continue; }
      r.leave_type = t.key; r.leave_label = t.label;
      if (!validDay(r.from) || !validDay(r.to)) { results.push({ ...r, ok: false, error: "Not a real date (check the day and month)" }); continue; }
      if (r.to < r.from) { results.push({ ...r, ok: false, error: "End date is before start date" }); continue; }
      if ((Date.parse(r.to) - Date.parse(r.from)) / DAY > 90) { results.push({ ...r, ok: false, error: "One row can cover at most 90 days" }); continue; }
      let days = 0;
      for (let d = r.from; d <= r.to; d = addDays(d, 1)) if (!isOff(d)) days++;
      r.days = days;
      if (!days) { results.push({ ...r, ok: false, error: "Those dates are all weekly offs or holidays" }); continue; }
      const clash = await Leave.findOne({ user_id: u._id, status: { $in: ["pending", "approved"] },
        from_date: { $lte: new Date(`${r.to}T00:00:00Z`) }, to_date: { $gte: new Date(`${r.from}T00:00:00Z`) } }).lean();
      if (clash) { results.push({ ...r, ok: false, error: `Overlaps ${clash.status} leave ${istYmd(clash.from_date)} to ${istYmd(clash.to_date)}` }); continue; }
      if (batch.some((b) => String(b.user._id) === String(u._id) && b.from <= r.to && b.to >= r.from)) {
        results.push({ ...r, ok: false, error: "Overlaps another row in this list" }); continue;
      }
      const reason = String(it.reason || "").trim();
      r.reason = reason.length >= 20 ? reason.slice(0, 1000) : reason ? `${reason} (recorded by admin)`.padEnd(20, ".") : "Leave recorded by admin (bulk entry)";
      r.ok = true;
      batch.push(r);
      results.push(r);
    }
    let saved = 0;
    if (!req.body?.dry_run && batch.length) {
      const docs = batch.map((r) => ({
        user_id: r.user._id, leave_type: r.leave_type,
        from_date: new Date(`${r.from}T00:00:00Z`), to_date: new Date(`${r.to}T00:00:00Z`), // same as the leave form saves
        days: r.days, reason: r.reason, status: "approved",
        reviewed_by: req.user._id, reviewed_at: new Date(), admin_note: `Added by ${req.user.name || "admin"} (bulk)`,
      }));
      const created = await Leave.insertMany(docs, { ordered: false });
      saved = created.length;
      // Let each employee know (same kind of in-app notification as a normal approval)
      try {
        const Notification = require("../models/notification");
        await Notification.insertMany(created.map((l, i) => ({
          user_id: l.user_id, sender_id: req.user._id, type: "general", ref_id: l._id,
          message: `🗓️ ${batch[i].leave_label} recorded for you: ${batch[i].from === batch[i].to ? batch[i].from : `${batch[i].from} to ${batch[i].to}`} (${l.days} day${l.days === 1 ? "" : "s"}).`,
        })));
      } catch (err) { console.error("[bulk leave] notify failed:", err.message); }
    }
    res.json({ success: true, data: { saved, ready: batch.length, results } });
  } catch (e) {
    if (e.name === "ValidationError") return res.status(400).json({ success: false, message: Object.values(e.errors).map((x) => x.message).join("; ") });
    fail(res, e);
  }
};

// ─── Fingerprint machine ─────────────────────────────────────────────────────
const EsslDevice = require("../models/esslDevice");

// GET /api/attendance-app/machine
// Machines seen, their recent commands, and every user enrolled on them matched to employees.
const getMachine = async (req, res) => {
  try {
    const [devices, people, unassigned] = await Promise.all([
      EsslDevice.find({}).sort({ last_seen: -1 }).lean(),
      User.find({}).select("name employee_id fingerprint_id status department").lean(),
      UnmatchedPunch.find({}).select("device_id punches last_seen").lean(),
    ]);
    const byFp = new Map(people.filter((u) => u.fingerprint_id).map((u) => [String(u.fingerprint_id).trim(), u]));
    const byEmp = new Map(people.filter((u) => u.employee_id).map((u) => [String(u.employee_id).trim(), u]));
    const kept = new Map(unassigned.map((u) => [u.device_id, u.punches.length]));
    const users = new Map();
    for (const d of devices) for (const u of d.users || []) {
      const x = users.get(u.pin) || { pin: u.pin, name: u.name, machines: [] };
      x.machines.push(d.serial);
      if (!x.name && u.name) x.name = u.name;
      users.set(u.pin, x);
    }
    // IDs with punches but not in any machine list yet
    for (const id of kept.keys()) if (!users.has(id)) users.set(id, { pin: id, name: "", machines: [] });
    const list = [...users.values()].map((u) => {
      const e = byFp.get(u.pin) || byEmp.get(u.pin) || null;
      return { ...u, employee: e && { _id: e._id, name: e.name, employee_id: e.employee_id || null, fingerprint_id: e.fingerprint_id || null, status: e.status },
        matched_by: e ? (byFp.get(u.pin) ? "device_id" : "employee_id") : null, unassigned_punches: kept.get(u.pin) || 0 };
    }).sort((a, b) => (Boolean(a.employee) - Boolean(b.employee)) || a.pin.localeCompare(b.pin, undefined, { numeric: true }));
    const now = Date.now();
    res.json({ success: true, data: {
      devices: devices.map((d) => ({
        serial: d.serial, last_seen: d.last_seen, online: d.last_seen && now - new Date(d.last_seen) < 3 * 60 * 1000,
        last_ip: d.last_ip, last_punches_at: d.last_punches_at, last_punches_count: d.last_punches_count,
        users_count: (d.users || []).length, users_updated_at: d.users_updated_at,
        info: d.info?.at ? { firmware: d.info.firmware, users: d.info.users, fingerprints: d.info.fingerprints, punches: d.info.punches, ip: d.info.ip, at: d.info.at } : null,
        users_missing: d.info?.users != null ? Math.max(0, d.info.users - (d.users || []).length) : null,
        // Waiting requests always; finished ones only for 10 minutes after they finished
        commands: (d.commands || []).filter((c) => !["done", "failed"].includes(c.status) || c.done_at && now - new Date(c.done_at) < 10 * 60 * 1000)
          .slice(-6).reverse(),
        users_pending: (d.commands || []).some((c) => (c.status === "queued" || c.status === "sent") && c.cmd.startsWith("DATA QUERY USERINFO")),
        punches_pending: (d.commands || []).some((c) => (c.status === "queued" || c.status === "sent") && c.cmd.startsWith("DATA QUERY ATTLOG")),
        last_handshake_at: d.last_handshake_at, last_handshake_query: d.last_handshake_query,
        resend_all: Boolean(d.resend_all), resend_all_requested_at: d.resend_all_requested_at, resend_all_sent_at: d.resend_all_sent_at,
        unknown_calls: (d.unknown_calls || []).slice(-5).reverse(),
      })),
      users: list,
      employees_without_device_id: people.filter((p) => p.status !== "inactive" && !p.fingerprint_id).map((p) => ({ _id: p._id, name: p.name, employee_id: p.employee_id || null })),
    } });
  } catch (e) { fail(res, e); }
};

const targetDevices = async (serial) => {
  const q = serial ? { serial: String(serial) } : {};
  const list = await EsslDevice.find(q).select("serial").lean();
  if (!list.length) throw new HttpError(404, serial ? `Machine ${serial} hasn't contacted the server yet` : "No fingerprint machine has contacted the server yet");
  return list.map((d) => d.serial);
};

// POST /api/attendance-app/machine/resync { from, to, serial? }
// Asks the machine to send its punches for these dates again. Already-saved punches are ignored.
const machineResync = async (req, res) => {
  try {
    const from = parseYmd(req.body?.from, "from"), to = parseYmd(req.body?.to || req.body?.from, "to");
    if (to < from) throw new HttpError(400, "End date is before start date");
    if ((Date.parse(to) - Date.parse(from)) / DAY > 62) throw new HttpError(400, "Pick at most 2 months at a time");
    // The machine searches by its OWN clock: widen by the clock correction so nothing at the edges is missed.
    const pol = await loadPolicy();
    const pad = Math.abs(pol.clockOffset || 0);
    const fmt = (ms) => new Date(ms + IST).toISOString().replace("T", " ").slice(0, 19);
    const start = fmt(dayStart(from).getTime() - pad * 60000);
    const end = fmt(dayStart(to).getTime() + DAY - 1000 + pad * 60000);
    const { queueDeviceCommand } = require("./EsslController");
    const serials = await targetDevices(req.body?.serial);
    for (const sn of serials) {
      await queueDeviceCommand(sn, `DATA QUERY ATTLOG StartTime=${start}\tEndTime=${end}`, `Re-send punches ${from} to ${to}`, req.user.name || "");
    }
    res.json({ success: true, data: { queued: serials.length, serials } });
  } catch (e) { fail(res, e); }
};

// POST /api/attendance-app/machine/clear-requests { serial?, id? }
// Removes finished (done / not answered) requests from the list: one (id) or all.
const machineClearRequests = async (req, res) => {
  try {
    const q = req.body?.serial ? { serial: String(req.body.serial) } : {};
    const finished = { status: { $in: ["done", "failed"] }, ...(req.body?.id != null ? { id: Number(req.body.id) } : {}) };
    const r = await EsslDevice.updateMany(q, { $pull: { commands: finished } });
    res.json({ success: true, data: { updated: r.modifiedCount } });
  } catch (e) { fail(res, e); }
};

// POST /api/attendance-app/machine/full-upload { serial? }
// Older-firmware method: at its next connection the machine re-sends ALL punches and users.
const machineFullUpload = async (req, res) => {
  try {
    const { requestFullUpload } = require("./EsslController");
    const serials = await targetDevices(req.body?.serial);
    for (const sn of serials) await requestFullUpload(sn, req.user.name || "");
    res.json({ success: true, data: { queued: serials.length, serials } });
  } catch (e) { fail(res, e); }
};

// POST /api/attendance-app/machine/restart { serial? } — the machine restarts and reconnects (about 1 minute)
const machineRestart = async (req, res) => {
  try {
    const { queueDeviceCommand } = require("./EsslController");
    const serials = await targetDevices(req.body?.serial);
    for (const sn of serials) await queueDeviceCommand(sn, "REBOOT", "Restart the machine", req.user.name || "");
    res.json({ success: true, data: { queued: serials.length, serials } });
  } catch (e) { fail(res, e); }
};

// POST /api/attendance-app/machine/fetch-users { serial? } — asks the machine for its user list
const machineFetchUsers = async (req, res) => {
  try {
    const { queueDeviceCommand } = require("./EsslController");
    const serials = await targetDevices(req.body?.serial);
    for (const sn of serials) await queueDeviceCommand(sn, "DATA QUERY USERINFO", "Send the list of users", req.user.name || "");
    res.json({ success: true, data: { queued: serials.length, serials } });
  } catch (e) { fail(res, e); }
};

// POST /api/attendance-app/machine/create-employees
// { items: [{ pin, name, email?, employee_id? }], department, designation, no_email_ok?, dry_run? }
// Creates employees for people enrolled on the fingerprint machine who have no employee record.
// Device ID = the machine number (pin). Each gets a temporary password (returned once) and
// any punches the machine already sent for that number are added to their attendance.
const createEmployeesFromMachine = async (req, res) => {
  try {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new HttpError(400, "Choose at least one person from the machine");
    if (items.length > 200) throw new HttpError(400, "At most 200 people at once");
    // quick: name + email for a machine number; default department/designation. Email is optional (attendance-only staff get a placeholder address and cannot sign in).
    const department = String(b.department || (b.quick ? "General" : "")).trim(), designation = String(b.designation || (b.quick ? "Staff" : "")).trim();
    if (!department) throw new HttpError(400, "Choose a department");
    if (!designation) throw new HttpError(400, "Enter a designation");
    const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const existing = await User.find({}).select("email employee_id fingerprint_id name").lean();
    const emails = new Map(existing.map((u) => [String(u.email || "").toLowerCase(), u.name]));
    const empIds = new Map(existing.filter((u) => u.employee_id).map((u) => [String(u.employee_id).trim(), u.name]));
    const devIds = new Map(existing.filter((u) => u.fingerprint_id).map((u) => [String(u.fingerprint_id).trim(), u.name]));
    const seen = { email: new Set(), emp: new Set(), pin: new Set() };

    const results = items.map((it, index) => {
      const pin = String(it.pin || "").trim(), name = String(it.name || "").trim().slice(0, 100);
      let email = String(it.email || "").trim().toLowerCase();
      const employee_id = String(it.employee_id || "").trim();
      const r = { index, pin, name, email, employee_id: employee_id || null };
      const bad = (error) => ({ ...r, ok: false, error });
      if (!pin) return bad("Machine number is missing");
      if (devIds.has(pin)) return bad(`Device ID ${pin} already belongs to ${devIds.get(pin)}`);
      if (seen.pin.has(pin)) return bad("This machine number is listed twice");
      if (!name) return bad("Enter a name");
      if (!email) {
        // No email: attendance only. A unique placeholder keeps the user record valid; they can't sign in.
        do { email = `device-${pin}-${Math.random().toString(36).slice(2, 6)}@no-email.invalid`; } while (emails.has(email) || seen.email.has(email));
        r.email = email; r.no_email = true;
      } else {
        if (!EMAIL.test(email) || isPlaceholderEmail(email)) return bad("Email doesn't look right");
        if (emails.has(email)) return bad(`Email already used by ${emails.get(email)}`);
        if (seen.email.has(email)) return bad("This email is listed twice");
      }
      if (employee_id && empIds.has(employee_id)) return bad(`Employee ID ${employee_id} already belongs to ${empIds.get(employee_id)}`);
      if (employee_id && seen.emp.has(employee_id)) return bad("This Employee ID is listed twice");
      seen.pin.add(pin); seen.email.add(email); if (employee_id) seen.emp.add(employee_id);
      return { ...r, ok: true };
    });

    const ready = results.filter((r) => r.ok);
    if (b.dry_run || !ready.length) return res.json({ success: true, data: { created: 0, ready: ready.length, results } });

    const bcrypt = require("bcryptjs");
    const crypto = require("crypto");
    const { importUnmatchedPunches } = require("./EsslController");
    const makePassword = () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      return Array.from({ length: 10 }, () => chars[crypto.randomInt(chars.length)]).join("");
    };
    let created = 0;
    for (const r of ready) {
      try {
        const password = makePassword();
        const user = await User.create({
          name: r.name, email: r.email, password: await bcrypt.hash(password, 10),
          role: "employee", status: "active", department, designation,
          fingerprint_id: r.pin, ...(r.employee_id ? { employee_id: r.employee_id } : {}),
        });
        r.user_id = user._id;
        if (!r.no_email) r.temporary_password = password; // shown once to the admin
        const imp = await importUnmatchedPunches(r.pin, user).catch(() => ({ punches: 0 }));
        r.imported_punches = imp.punches || 0;
        created++;
      } catch (err) {
        r.ok = false;
        r.error = err.code === 11000 ? "Email or ID already in use" : err.name === "ValidationError"
          ? Object.values(err.errors).map((x) => x.message).join("; ") : "Couldn't create this person";
        console.error("[create from machine]", r.pin, err.message);
      }
    }
    res.json({ success: true, data: { created, ready: ready.length, results } });
  } catch (e) { fail(res, e); }
};

module.exports = { machineClearRequests, machineFullUpload, machineRestart, createEmployeesFromMachine, getMachine, machineResync, machineFetchUsers, bulkHolidays, bulkLeaves, getDataHealth, repairData, undoRepair, listIds, saveIds, discardUnassigned, setUserIds, saveDayRecord, listUsers, getDay, getUserTimeline, getRegister, getLeaveBalance,
  _internals: { evaluate, resolveDays, summarise, istYmd, dayStart } };
