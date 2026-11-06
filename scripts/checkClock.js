/**
 * scripts/checkClock.js — why are new punches still showing the machine's (wrong) time?
 *   node scripts/checkClock.js
 * Read-only. Shows: the correction saved in Settings, whether each file that applies it
 * is the updated version, and the latest punches (machine time vs saved time).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const root = path.join(__dirname, "..");
const IST = 5.5 * 3600e3;
const ist = (d) => new Date(new Date(d).getTime() + IST).toISOString().replace("T", " ").slice(0, 16);
const has = (f, text) => { try { return fs.readFileSync(path.join(root, f), "utf8").includes(text); } catch { return false; } };
let problems = [];

console.log("1. Code that applies the correction (must be the updated versions)");
const CODE = [
  ["models/policy.js", "device_clock_offset_minutes", "can't store the correction: Settings saves 30 but it's dropped"],
  ["controllers/policyController.js", "device_clock_offset_since", "doesn't save the correction"],
  ["services/attendanceRules.js", "correctDeviceTime", "has no correction function"],
  ["controllers/EsslController.js", "correctDeviceTime", "saves punches WITHOUT the correction"],
  ["models/attendance.js", "clock_offset_applied", "can't mark corrected punches"],
];
for (const [f, marker, why] of CODE) {
  const ok = has(f, marker);
  console.log(`   ${ok ? "✓" : "✗ OLD VERSION"}  ${f}${ok ? "" : `  → ${why}`}`);
  if (!ok) problems.push(`Replace ${f} with the updated file.`);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log("\n2. Setting saved in the database (active policy)");
  const pol = await db.collection("policies").find({ is_active: true }).sort({ createdAt: -1 }).limit(1).next();
  const off = Number(pol?.device_clock_offset_minutes || 0);
  console.log(`   Machine is behind by: ${pol && pol.device_clock_offset_minutes !== undefined ? `${off} min` : "NOT SAVED (field missing)"}`);
  console.log(`   Set on: ${pol?.device_clock_offset_since ? ist(pol.device_clock_offset_since) + " IST" : "-"}`);
  console.log(`   Work start / late grace: ${pol?.work_start_time || "?"} / ${pol?.late_threshold_minutes ?? "?"} min`);
  const nActive = await db.collection("policies").countDocuments({ is_active: true });
  if (nActive > 1) { console.log(`   ⚠ ${nActive} active policies; the newest one is used`); }
  if (!off) problems.push("Set 'Machine is behind real time by' = 30 in the app (Settings) and press Save settings, then run this again.");

  console.log("\n3. Latest machine punches (newest first)");
  const recs = await db.collection("attendances").find({ "raw_logs.0": { $exists: true } }).sort({ updatedAt: -1 }).limit(15).toArray();
  const users = new Map((await db.collection("users").find({ _id: { $in: recs.map((r) => r.user_id) } }).project({ name: 1 }).toArray()).map((u) => [String(u._id), u.name]));
  const punches = recs.flatMap((r) => (r.raw_logs || []).map((l) => ({ who: users.get(String(r.user_id)) || "?", time: l.time, applied: Number(l.clock_offset_applied) || 0, saved: r.updatedAt })))
    .sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 10);
  let newUncorrected = 0;
  for (const p of punches) {
    const machine = new Date(new Date(p.time) - p.applied * 60000);
    // Punched after the setting was turned on? (machine time + correction ≈ real time of the punch)
    const after = pol?.device_clock_offset_since && machine.getTime() + off * 60000 > new Date(pol.device_clock_offset_since).getTime() + 60000;
    if (off && after && !p.applied) newUncorrected++;
    console.log(`   ${p.who.padEnd(22).slice(0, 22)} machine ${ist(machine).slice(11)}  →  shown ${ist(p.time).slice(11)}  ${p.applied ? `(+${p.applied} applied)` : off ? (after ? "✗ NOT corrected although the setting was on" : "(old punch, fix with Check & fix data)") : "(no correction set)"}  ${ist(p.time).slice(0, 10)}`);
  }
  if (newUncorrected) problems.push("Punches saved after the setting was turned on were not corrected: the running server uses old code or wasn't restarted. Pull the updated files, then: pm2 restart 2");

  console.log("\n4. Server process");
  try {
    const started = require("child_process").execSync("pm2 jlist", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const app = JSON.parse(started).find((x) => x.pm2_env?.pm_cwd === root || x.name === "ProjectManagementBackend");
    if (app) {
      const up = new Date(app.pm2_env.pm_uptime);
      const newest = ["controllers/EsslController.js", "models/policy.js", "controllers/policyController.js", "services/attendanceRules.js"]
        .map((f) => fs.statSync(path.join(root, f)).mtime).sort((a, b) => b - a)[0];
      const stale = newest > up;
      console.log(`   Running since ${ist(up)} IST, status ${app.pm2_env.status}${stale ? "  ✗ files changed AFTER it started: run pm2 restart 2" : "  ✓ started after the latest file change"}`);
      if (stale) problems.push("Restart the server so it uses the new files: pm2 restart 2");
    }
  } catch { console.log("   (pm2 not available here)"); }

  console.log(problems.length ? `\nTo fix:\n${[...new Set(problems)].map((p, i) => `  ${i + 1}. ${p}`).join("\n")}` : "\n✓ Correction is set, the code applies it, and new punches are corrected.");
  await mongoose.disconnect();
})().catch(async (e) => { console.error("Check failed:", e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
