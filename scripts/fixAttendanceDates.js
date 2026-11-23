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
// The repair itself lives in services/attendanceRepair.js (also used by the admin app:
// Settings → Check & fix data). This file only reads the options and prints the result.
require("dotenv").config();
const path = require("path");
const mongoose = require("mongoose");
const { runRepair, restoreBackup } = require("../services/attendanceRepair");

const has = (f) => process.argv.includes(f);
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const APPLY = has("--apply");
const FROM = arg("from"), TO = arg("to"), RESTORE = arg("restore"), OFFSET = arg("offset");
for (const [k, v] of [["from", FROM], ["to", TO]]) {
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`--${k} must be YYYY-MM-DD`); process.exit(1); }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/project-management");
  console.log(`Connected to ${mongoose.connection.name}. Mode: ${APPLY ? "APPLY (writing changes)" : "DRY RUN (no changes)"}`);

  if (RESTORE) {
    const r = await restoreBackup(RESTORE, { apply: APPLY });
    console.log(`Backup from ${new Date(r.created_at).toISOString()} (${r.args.join(" ")}): ${r.records} records`);
    console.log(APPLY ? `✅ Restored ${r.restored} records.` : "Nothing was written. Add --apply to restore these records exactly as they were.");
    return mongoose.disconnect();
  }

  const r = await runRepair({
    apply: APPLY, keepStatus: has("--keep-status"),
    correctClock: has("--correct-device-clock") || OFFSET !== null, offset: OFFSET !== null ? Number(OFFSET) : null,
    from: FROM, to: TO, args: process.argv.slice(2),
  });
  const s = r.stats;
  if (FROM || TO) console.log(`Only days ${FROM || "(start)"} to ${TO || "(today)"}`);
  if (r.clockOffsetMin) console.log(`Machine clock correction: ${r.clockOffsetMin > 0 ? "+" : ""}${r.clockOffsetMin} min for machine punches that haven't been corrected yet`);
  console.log(`\nScanned ${s.records} records on ${s.days} person-days.`);
  console.log(`  Moved to the correct IST day:     ${s.dateMoved}`);
  console.log(`  Duplicate days merged:            ${s.merged} (${s.deleted} extra records removed)`);
  console.log(`  Status recomputed from policy:    ${s.statusChanged}`);
  for (const [t, n] of Object.entries(r.transitions)) console.log(`      ${t}: ${n}`);
  console.log(`  Clock-in/out/hours recomputed:    ${s.timesChanged}`);
  console.log(`  Already correct:                  ${s.untouched}`);
  if (r.clockOffsetMin) console.log(`  Machine punches time-corrected:   ${s.punchesShifted}`);
  if (r.samples.length) {
    console.log("\nExamples:");
    for (const x of r.samples) console.log(`  ${x.day}  user ${x.user_id}  ${[x.merged && `merged ${x.merged} split record(s)`, x.status && `status ${x.status}`, x.clock_out !== undefined && `logout → ${x.clock_out ? new Date(x.clock_out).toISOString() : "none"}`].filter(Boolean).join(", ")}`);
  }
  if (r.applied) {
    console.log(`\n💾 Backup: ${r.backupFile}`);
    console.log(`   Undo with: node scripts/fixAttendanceDates.js --restore=${path.relative(process.cwd(), r.backupFile)} --apply`);
    console.log(`\n✅ Applied ${r.changes} changes.`);
  } else console.log(APPLY ? "\n✅ Nothing to change." : "\nNothing was written. Run again with --apply to make these changes.");
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Repair failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
