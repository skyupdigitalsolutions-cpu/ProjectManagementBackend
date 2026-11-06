/**
 * services/attendanceRepair.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Repairs stored attendance so it matches the current rules. Used by
 *   - the admin app (Settings → Check & fix data), and
 *   - scripts/fixAttendanceDates.js (command line).
 *
 * What it does:
 *  1. Puts every record on the right IST day, stored as 00:00 IST.
 *  2. Merges a person's records that ended up split across one day (for example
 *     morning punch saved by the old code, evening punch by the new code: both
 *     looked like "punched in, no punch out"). All punches are kept.
 *  3. Optionally adds the machine clock correction to punches that were saved
 *     without it (each punch is marked, so it's never applied twice).
 *  4. Recomputes login, logout, hours and status from the punches and the
 *     ACTIVE Policy. Days an admin marked (admin_locked) and "absent" /
 *     "on-leave" set by an admin are never recomputed.
 *
 * Before writing, every record it changes or deletes is saved to
 * backups/attendance-fix-<time>.json, so a run can be undone exactly.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Attendance = require("../models/attendance");
const Policy = require("../models/policy");
const rules = require("./attendanceRules");

const { EJSON } = mongoose.mongo.BSON;
const LOCKED = new Set(["absent", "on-leave"]);
const BACKUP_DIR = path.join(__dirname, "..", "backups");
const calcHours = (a, b) => Math.round(((new Date(b) - new Date(a)) / 36e5) * 100) / 100;
const essl = () => require("../controllers/EsslController")._internals; // lazy: avoids a load cycle

// Same punch clean-up as EsslController.upsertAttendanceFromPunches
function distinctPunches(logs) {
  const seen = new Set();
  const all = [];
  for (const l of logs) {
    const t = new Date(l.time);
    const key = t.getTime() - (Number(l.clock_offset_applied) || 0) * 60 * 1000; // the machine's own reading
    if (Number.isNaN(t.getTime()) || seen.has(key)) continue;
    seen.add(key);
    all.push({ time: t, type: String(l.type ?? "0"), verify: String(l.verify ?? "1"),
      ...(l.clock_offset_applied != null && { clock_offset_applied: l.clock_offset_applied }) });
  }
  all.sort((a, b) => a.time - b.time);
  const distinct = [];
  for (const p of all) {
    const last = distinct[distinct.length - 1];
    if (last && p.time - last.time < essl().PUNCH_MERGE_WINDOW_MS) continue;
    distinct.push(p);
  }
  return { all, distinct };
}

// IST day a record belongs to: its first (corrected) punch, else clock_in, else stored date
const dayOf = (r) => r._dayKey || rules.istDateKey(r.clock_in || r.date);

function plan(group, policy, keepStatus) {
  const score = (r) => (r.source === "fingerprint" && r.raw_logs?.length ? 4 : 0) + (r.clock_out ? 2 : 0) + (r.clock_in ? 1 : 0);
  const sorted = [...group].sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt);
  const keep = sorted[0];
  const extras = sorted.slice(1);
  const key = dayOf(keep);
  const set = {};
  const target = rules.istDayStart(key);
  if (+new Date(keep.date) !== +target) set.date = target;

  const lockedStatus = group.find((r) => LOCKED.has(r.status) && !r.clock_in)?.status;
  const logs = group.flatMap((r) => r.raw_logs || []);

  if (group.some((r) => r.admin_locked)) {
    if (group.some((r) => r._shifted) || extras.length) set.raw_logs = distinctPunches(logs).all;
  } else if (logs.length) {
    const { all, distinct } = distinctPunches(logs);
    if (distinct.length) {
      const d = essl().deriveFromDistinct(distinct, new Date());
      const status = keepStatus || LOCKED.has(keep.status) ? keep.status : rules.deriveStatus(d.clock_in, d.hours_worked, policy);
      const changed = (a, b) => (a instanceof Date || b instanceof Date ? +new Date(a || 0) !== +new Date(b || 0) : a !== b);
      for (const [k, v] of Object.entries({ clock_in: d.clock_in, clock_out: d.clock_out, hours_worked: d.hours_worked, break_minutes: d.break_minutes, status })) {
        if (changed(keep[k] ?? null, v ?? null)) set[k] = v;
      }
      if (extras.length || group.some((r) => r._shifted)) { set.raw_logs = all; set.source = "fingerprint"; }
    }
  } else if (keep.clock_in && !keep.no_times) {
    const ins = group.map((r) => r.clock_in).filter(Boolean).map((t) => new Date(t));
    const outs = group.map((r) => r.clock_out).filter(Boolean).map((t) => new Date(t));
    const clockIn = new Date(Math.min(...ins));
    const clockOut = outs.length ? new Date(Math.max(...outs)) : null;
    if (+clockIn !== +new Date(keep.clock_in)) set.clock_in = clockIn;
    if (clockOut && +clockOut !== +new Date(keep.clock_out || 0)) { set.clock_out = clockOut; set.hours_worked = calcHours(clockIn, clockOut); }
    if (!keepStatus && !LOCKED.has(keep.status)) {
      const status = rules.deriveStatus(clockIn, clockOut ? calcHours(clockIn, clockOut) : null, policy);
      if (status !== keep.status) set.status = status;
    }
  }
  if (lockedStatus && keep.status !== lockedStatus && !keep.clock_in) set.status = lockedStatus;
  return { keep, extras, set, key };
}

/**
 * opts: { apply=false, keepStatus=false, correctClock=false, offset (minutes, default
 *         from Policy), from, to ("YYYY-MM-DD"), args (for the backup label) }
 * Returns a summary; when apply is true and something changed, includes backupFile.
 */
async function runRepair(opts = {}) {
  const { apply = false, keepStatus = false, from = null, to = null } = opts;
  const policy = await rules.loadRules(true);
  const inRange = (day) => (!from || day >= from) && (!to || day <= to);

  let clockOffsetMin = 0;
  if (opts.correctClock || opts.offset != null) {
    const pol = await Policy.findOne({ is_active: true }).sort({ createdAt: -1 }).lean();
    clockOffsetMin = opts.offset != null ? Number(opts.offset) : Number(pol?.device_clock_offset_minutes || 0);
    if (!Number.isFinite(clockOffsetMin) || Math.abs(clockOffsetMin) > 720) throw new Error("The clock correction must be between -720 and 720 minutes.");
  }

  const filter = {};
  if (from || to) filter.date = {};
  if (from) filter.date.$gte = new Date(rules.istDayStart(from).getTime() - rules.DAY_MS);
  if (to) filter.date.$lt = new Date(rules.istDayStart(to).getTime() + 2 * rules.DAY_MS);
  const records = await Attendance.find(filter).sort({ user_id: 1, date: 1 }).lean();

  let punchesShifted = 0;
  if (clockOffsetMin) {
    for (const r of records) {
      if (!r.raw_logs?.length || !inRange(dayOf(r))) continue;
      let changed = false;
      r.raw_logs = r.raw_logs.map((l) => {
        if (Number(l.clock_offset_applied) || 0) return l;
        changed = true; punchesShifted++;
        return { ...l, time: new Date(new Date(l.time).getTime() + clockOffsetMin * 60 * 1000), clock_offset_applied: clockOffsetMin };
      });
      if (changed) {
        r._shifted = true;
        r._dayKey = rules.istDateKey(r.raw_logs.map((l) => new Date(l.time)).sort((a, b) => a - b)[0]);
      }
    }
  }

  const groups = new Map();
  for (const r of records) {
    if (!inRange(dayOf(r))) continue;
    const k = `${r.user_id}|${dayOf(r)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const stats = { records: records.length, days: groups.size, dateMoved: 0, merged: 0, deleted: 0, statusChanged: 0, timesChanged: 0, untouched: 0, punchesShifted };
  const transitions = {};
  const samples = [];
  const ops = [];
  for (const group of groups.values()) {
    const { keep, extras, set, key } = plan(group, policy, keepStatus);
    if (!Object.keys(set).length && !extras.length) { stats.untouched++; continue; }
    if (set.date) stats.dateMoved++;
    if (extras.length) { stats.merged++; stats.deleted += extras.length; }
    if (set.status) { stats.statusChanged++; const t = `${keep.status} → ${set.status}`; transitions[t] = (transitions[t] || 0) + 1; }
    if (set.clock_in || set.clock_out !== undefined || set.hours_worked !== undefined) stats.timesChanged++;
    if (samples.length < 15) samples.push({ day: key, user_id: String(keep.user_id), merged: extras.length, status: set.status ? `${keep.status} → ${set.status}` : null,
      clock_in: set.clock_in || null, clock_out: set.clock_out !== undefined ? set.clock_out : undefined });
    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: keep._id }, update: { $set: set } } });
    if (extras.length) ops.push({ deleteMany: { filter: { _id: { $in: extras.map((r) => r._id) } } } });
  }

  const result = { applied: false, changes: ops.length, stats, transitions, samples, clockOffsetMin, backupFile: null };
  if (apply && ops.length) {
    const ids = ops.flatMap((o) => (o.updateOne ? [o.updateOne.filter._id] : o.deleteMany.filter._id.$in));
    const originals = await Attendance.collection.find({ _id: { $in: ids } }).toArray();
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `attendance-fix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, EJSON.stringify({ created_at: new Date(), args: opts.args || [], records: originals }, null, 0, { relaxed: false }));
    for (let i = 0; i < ops.length; i += 500) await Attendance.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    Object.assign(result, { applied: true, backupFile: file });
  }
  return result;
}

/** Puts back every record saved in a backup file, exactly as it was. */
async function restoreBackup(file, { apply = false } = {}) {
  const data = EJSON.parse(fs.readFileSync(file, "utf8"), { relaxed: false });
  const recs = data.records || [];
  if (apply && recs.length) {
    const ops = recs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }));
    for (let i = 0; i < ops.length; i += 500) await Attendance.collection.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }
  return { created_at: data.created_at, args: data.args || [], records: recs.length, restored: apply ? recs.length : 0 };
}

/** Quick health numbers for the admin app (no changes). */
async function dataHealth({ days = 60 } = {}) {
  const pol = await Policy.findOne({ is_active: true }).sort({ createdAt: -1 }).lean();
  const offset = Number(pol?.device_clock_offset_minutes || 0);
  const since = new Date(Date.now() - days * rules.DAY_MS);
  const recs = await Attendance.find({ date: { $gte: since } }).select("user_id date clock_in raw_logs source admin_locked").lean();
  const perDay = new Map();
  let wrongMidnight = 0, uncorrected = 0;
  for (const r of recs) {
    const k = `${r.user_id}|${dayOf(r)}`;
    perDay.set(k, (perDay.get(k) || 0) + 1);
    if (+new Date(r.date) !== +rules.istDayStart(dayOf(r))) wrongMidnight++;
    if (offset) uncorrected += (r.raw_logs || []).filter((l) => !(Number(l.clock_offset_applied) || 0)).length;
  }
  const splitDays = [...perDay.values()].filter((n) => n > 1).length;
  const last = await Attendance.findOne({ source: "fingerprint" }).sort({ updatedAt: -1 }).select("updatedAt").lean();
  return { days, clock_offset_minutes: offset, split_days: splitDays, wrong_day_records: wrongMidnight,
    uncorrected_punches: uncorrected, last_machine_update: last?.updatedAt || null,
    needs_repair: splitDays > 0 || wrongMidnight > 0 || uncorrected > 0 };
}

module.exports = { runRepair, restoreBackup, dataHealth, distinctPunches };
