/**
 * scripts/fixAttendanceDates.js — one-time repair of existing attendance records.
 *
 *   node scripts/fixAttendanceDates.js            # dry run: shows what would change, writes nothing
 *   node scripts/fixAttendanceDates.js --apply    # writes the changes
 *
 * Options:
 *   --from=YYYY-MM-DD   only records on/after this IST day (default: all)
 *   --to=YYYY-MM-DD     only records on/before this IST day (default: all)
 *   --offset=MINUTES    machine clock correction to use for old punches
 *                       (default: the value set in Settings). Implies --correct-device-clock.
 *   --restore=FILE      undo an earlier --apply using the backup file it wrote
 *                       (preview first; add --apply to actually restore)
 *
 * Every --apply first saves the records it is about to change to
 * backups/attendance-fix-<time>.json, so it can be undone with --restore.
 *   --keep-status       fix dates and merge duplicates, but don't recompute status
 *   --correct-device-clock
 *                       also correct machine punches that were saved without the
 *                       clock correction set in Settings (Policy.device_clock_offset_minutes).
 *                       Each such punch gets the correction added once and is marked,
 *                       so running it again never shifts anything twice.
 *
 * What it does (uses MONGO_URI from .env, same as the server):
 *  1. Puts every record on the right IST day. The day is taken from clock_in
 *     when there is one (so punches before 05:30 IST that were filed under the
 *     previous day move back), otherwise from the stored date. `date` becomes
 *     00:00 IST of that day, the convention the whole backend now uses.
 *  2. Merges duplicates: when one person ends up with two records on one day
 *     (e.g. an app clock-in and a fingerprint record), they become one record
 *     with all punches; the extra record is deleted.
 *  3. Recomputes status from the ACTIVE Policy (late grace, half-day hours,
 *     weekly offs, holidays). Fingerprint days are re-derived from their raw
 *     punches exactly like the eSSL controller does. Records an admin marked
 *     "absent" or "on-leave" are never changed.
 *
 * Safe to run more than once: a second run finds nothing to change.
 * Back up first:  mongodump --uri="$MONGO_URI" --out=backup-before-attendance-fix
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Attendance = require("../models/attendance");
const rules = require("../services/attendanceRules");
const { _internals: essl } = require("../controllers/EsslController");

const APPLY = process.argv.includes("--apply");
const KEEP_STATUS = process.argv.includes("--keep-status");
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const OFFSET_ARG = arg("offset");
const CORRECT_CLOCK = process.argv.includes("--correct-device-clock") || OFFSET_ARG !== null;
const TO = arg("to");
const RESTORE = arg("restore");
const fs = require("fs");
const path = require("path");
const { EJSON } = mongoose.mongo.BSON;
const Policy = require("../models/policy");
const FROM = arg("from");
for (const [k, v] of [["from", FROM], ["to", TO]]) {
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`--${k} must be YYYY-MM-DD`); process.exit(1); }
}
const inRange = (day) => (!FROM || day >= FROM) && (!TO || day <= TO);
const LOCKED = new Set(["absent", "on-leave"]);

const calcHours = (a, b) => Math.round(((new Date(b) - new Date(a)) / 36e5) * 100) / 100;

// Same punch clean-up as EsslController.upsertAttendanceFromPunches
function distinctPunches(logs) {
  const seen = new Set();
  const all = [];
  for (const l of logs) {
    const t = new Date(l.time);
    const key = t.getTime() - (Number(l.clock_offset_applied) || 0) * 60 * 1000; // machine reading, like EsslController
    if (Number.isNaN(t.getTime()) || seen.has(key)) continue;
    seen.add(key);
    all.push({ time: t, type: String(l.type ?? "0"), verify: String(l.verify ?? "1"),
      ...(l.clock_offset_applied != null && { clock_offset_applied: l.clock_offset_applied }) });
  }
  all.sort((a, b) => a.time - b.time);
  const distinct = [];
  for (const p of all) {
    const last = distinct[distinct.length - 1];
    if (last && p.time - last.time < essl.PUNCH_MERGE_WINDOW_MS) continue;
    distinct.push(p);
  }
  return { all, distinct };
}

// IST day a record belongs to: its first (corrected) punch, else clock_in, else stored date
const dayOf = (r) => r._dayKey || rules.istDateKey(r.clock_in || r.date);

function plan(group, policy) {
  // Fullest record first: fingerprint with punches > has clock_out > has clock_in
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
    // An admin marked this day: never recompute it. Only keep punch log corrections.
    if (group.some((r) => r._shifted) || extras.length) { set.raw_logs = distinctPunches(logs).all; }
  } else if (logs.length) {
    // Re-derive the day from every punch the device sent (all merged records)
    const { all, distinct } = distinctPunches(logs);
    if (distinct.length) {
      const d = essl.deriveFromDistinct(distinct, new Date());
      const status = KEEP_STATUS || LOCKED.has(keep.status) ? keep.status : rules.deriveStatus(d.clock_in, d.hours_worked, policy);
      const changed = (a, b) => (a instanceof Date || b instanceof Date ? +new Date(a || 0) !== +new Date(b || 0) : a !== b);
      for (const [k, v] of Object.entries({ clock_in: d.clock_in, clock_out: d.clock_out, hours_worked: d.hours_worked, break_minutes: d.break_minutes, status })) {
        if (changed(keep[k] ?? null, v ?? null)) set[k] = v;
      }
      if (extras.length || group.some((r) => r._shifted)) { set.raw_logs = all; set.source = "fingerprint"; }
    }
  } else if (keep.clock_in) {
    // App / WFH clock-ins: merge times from duplicates, then policy status
    const ins = group.map((r) => r.clock_in).filter(Boolean).map((t) => new Date(t));
    const outs = group.map((r) => r.clock_out).filter(Boolean).map((t) => new Date(t));
    const clockIn = new Date(Math.min(...ins));
    const clockOut = outs.length ? new Date(Math.max(...outs)) : null;
    if (+clockIn !== +new Date(keep.clock_in)) set.clock_in = clockIn;
    if (clockOut && +clockOut !== +new Date(keep.clock_out || 0)) { set.clock_out = clockOut; set.hours_worked = calcHours(clockIn, clockOut); }
    if (!KEEP_STATUS && !LOCKED.has(keep.status)) {
      const status = rules.deriveStatus(clockIn, clockOut ? calcHours(clockIn, clockOut) : null, policy);
      if (status !== keep.status) set.status = status;
    }
  }
  if (lockedStatus && keep.status !== lockedStatus && !keep.clock_in) set.status = lockedStatus;
  return { keep, extras, set, key };
}

// Puts back every record saved in a backup file (exactly as it was).
async function restore(file) {
  const data = EJSON.parse(fs.readFileSync(file, "utf8"), { relaxed: false });
  const recs = data.records || [];
  console.log(`Backup from ${new Date(data.created_at).toISOString()} (${(data.args || []).join(" ")}): ${recs.length} records`);
  if (!APPLY) {
    console.log("Nothing was written. Add --apply to restore these records exactly as they were.");
    return mongoose.disconnect();
  }
  // Records written by the fixed code for the same person/day after the fix would
  // duplicate the restored ones; the restore only puts back what was saved.
  const ops = recs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }));
  for (let i = 0; i < ops.length; i += 500) await Attendance.collection.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  console.log(`✅ Restored ${recs.length} records.`);
  return mongoose.disconnect();
}

(async () => {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/project-management";
  await mongoose.connect(uri);
  if (RESTORE) return restore(RESTORE);
  const policy = await rules.loadRules(true);
  console.log(`Connected to ${mongoose.connection.name}. Mode: ${APPLY ? "APPLY (writing changes)" : "DRY RUN (no changes)"}`);
  console.log(`Policy: late after ${Math.floor(policy.lateAfterMinutes / 60)}:${String(policy.lateAfterMinutes % 60).padStart(2, "0")} IST, half-day under ${policy.halfDayHours} h, weekly offs [${policy.weeklyOffs}], ${policy.holidays.size} holidays`);

  // ── Machine clock correction for punches saved without it ──
  let clockOffsetMin = 0;
  if (CORRECT_CLOCK) {
    const pol = await Policy.findOne({ is_active: true }).sort({ createdAt: -1 }).lean();
    clockOffsetMin = OFFSET_ARG !== null ? Number(OFFSET_ARG) : Number(pol?.device_clock_offset_minutes || 0);
    if (!Number.isFinite(clockOffsetMin) || Math.abs(clockOffsetMin) > 720) {
      console.error("\n✋ --offset must be a number of minutes between -720 and 720."); await mongoose.disconnect(); process.exit(1);
    }
    if (!clockOffsetMin) {
      console.error("\n✋ No correction to apply. Use --offset=30, or set the machine clock correction in Settings, then run this again.");
      await mongoose.disconnect(); process.exit(1);
    }
    console.log(`Machine clock correction: ${clockOffsetMin > 0 ? "+" : ""}${clockOffsetMin} min for machine punches that haven't been corrected yet`);
  }

  const filter = {};
  if (FROM || TO) filter.date = {};
  if (FROM) filter.date.$gte = new Date(rules.istDayStart(FROM).getTime() - rules.DAY_MS);
  if (TO) filter.date.$lt = new Date(rules.istDayStart(TO).getTime() + 2 * rules.DAY_MS);
  if (FROM || TO) console.log(`Only days ${FROM || "(start)"} to ${TO || "(today)"}`);
  const records = await Attendance.find(filter).sort({ user_id: 1, date: 1 }).lean();

  let punchesShifted = 0;
  if (clockOffsetMin) {
    for (const r of records) {
      if (!r.raw_logs?.length) continue;
      if (!inRange(dayOf(r))) continue; // outside --from/--to: leave untouched
      let changed = false;
      // Each punch records the correction it already got (clock_offset_applied).
      // Only punches that never got one are shifted, and they're marked, so
      // running this again changes nothing.
      r.raw_logs = r.raw_logs.map((l) => {
        if (Number(l.clock_offset_applied) || 0) return l;
        changed = true; punchesShifted++;
        return { ...l, time: new Date(new Date(l.time).getTime() + clockOffsetMin * 60 * 1000), clock_offset_applied: clockOffsetMin };
      });
      if (changed) {
        r._shifted = true;
        // Group under the corrected day. (Don't overwrite clock_in here: the
        // stored value must stay as-is so the change is detected and written.)
        r._dayKey = rules.istDateKey(r.raw_logs.map((l) => new Date(l.time)).sort((a, b) => a - b)[0]);
      }
    }
  }

  const groups = new Map();
  for (const r of records) {
    const k = `${r.user_id}|${dayOf(r)}`;
    if (!inRange(dayOf(r))) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const stats = { records: records.length, days: groups.size, dateMoved: 0, merged: 0, deleted: 0, statusChanged: 0, timesChanged: 0, untouched: 0 };
  const transitions = {};
  const samples = [];
  const ops = [];

  for (const group of groups.values()) {
    const { keep, extras, set, key } = plan(group, policy);
    if (!Object.keys(set).length && !extras.length) { stats.untouched++; continue; }
    if (set.date) stats.dateMoved++;
    if (extras.length) { stats.merged++; stats.deleted += extras.length; }
    if (set.status) { stats.statusChanged++; const t = `${keep.status} → ${set.status}`; transitions[t] = (transitions[t] || 0) + 1; }
    if (set.clock_in || set.clock_out || set.hours_worked !== undefined) stats.timesChanged++;
    if (samples.length < 15) {
      samples.push(`  ${key}  user ${keep.user_id}  ${[
        set.date && `date ${new Date(keep.date).toISOString()} → ${set.date.toISOString()}`,
        set.status && `status ${keep.status} → ${set.status}`,
        extras.length && `merged ${extras.length} duplicate(s)`,
        set.clock_out !== undefined && `clock_out → ${set.clock_out ? set.clock_out.toISOString() : "none"}`,
      ].filter(Boolean).join(", ")}`);
    }
    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: keep._id }, update: { $set: set } } });
    if (extras.length) ops.push({ deleteMany: { filter: { _id: { $in: extras.map((r) => r._id) } } } });
  }

  console.log(`\nScanned ${stats.records} records on ${stats.days} person-days.`);
  console.log(`  Moved to the correct IST day:     ${stats.dateMoved}`);
  console.log(`  Duplicate days merged:            ${stats.merged} (${stats.deleted} extra records removed)`);
  console.log(`  Status recomputed from policy:    ${stats.statusChanged}`);
  for (const [t, n] of Object.entries(transitions)) console.log(`      ${t}: ${n}`);
  console.log(`  Clock-in/out/hours recomputed:    ${stats.timesChanged}`);
  console.log(`  Already correct:                  ${stats.untouched}`);
  if (CORRECT_CLOCK) console.log(`  Machine punches time-corrected:   ${punchesShifted}`);
  if (samples.length) console.log(`\nExamples:\n${samples.join("\n")}`);

  if (APPLY && ops.length) {
    // Backup every record this run changes or deletes, so it can be undone.
    const ids = ops.flatMap((o) => (o.updateOne ? [o.updateOne.filter._id] : o.deleteMany.filter._id.$in));
    const originals = await Attendance.collection.find({ _id: { $in: ids } }).toArray();
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `attendance-fix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, EJSON.stringify({ created_at: new Date(), args: process.argv.slice(2), records: originals }, null, 0, { relaxed: false }));
    console.log(`\n💾 Backup of ${originals.length} records: ${file}`);
    console.log(`   Undo with: node scripts/fixAttendanceDates.js --restore=${path.relative(process.cwd(), file)} --apply`);
    for (let i = 0; i < ops.length; i += 500) await Attendance.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    console.log(`\n✅ Applied ${ops.length} changes.`);
  } else if (!APPLY) {
    console.log(`\nNothing was written. Run again with --apply to make these changes.`);
  } else {
    console.log("\n✅ Nothing to change.");
  }
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Repair failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
