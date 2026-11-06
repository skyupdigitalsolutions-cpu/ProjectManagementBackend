/**
 * scripts/checkDeploy.js — run on the server, from the backend folder:
 *     node scripts/checkDeploy.js
 * Checks that every file the Attendance Admin app needs is present and that the
 * whole API loads, WITHOUT starting a second server. If something is missing it
 * says exactly which file. (A missing file stops the server from starting, and
 * the proxy then answers "502 Bad Gateway", which browsers report as a CORS error.)
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const NEEDED = [
  "services/attendanceRules.js", "services/attendanceRepair.js",
  "controllers/attendanceAppController.js", "controllers/passwordResetController.js",
  "routes/attendanceAppRoutes.js", "models/unmatchedPunch.js", "scripts/fixAttendanceDates.js",
  "routes/Index.js", "routes/Authroutes.js", "models/policy.js", "models/attendance.js", "models/users.js",
  "controllers/EsslController.js", "controllers/Attendancecontroller.js", "controllers/policyController.js",
  "services/attendanceAlerts.js", "routes/trackerRoutes.js",
];
let ok = true;
console.log("1. Files");
for (const f of NEEDED) {
  const there = fs.existsSync(path.join(root, f));
  if (!there) ok = false;
  console.log(`   ${there ? "✓" : "✗ MISSING"}  ${f}`);
}

console.log("2. Settings (.env)");
for (const k of ["MONGO_URI", "JWT_SECRET"]) {
  const set = Boolean(process.env[k]);
  if (!set) ok = false;
  console.log(`   ${set ? "✓" : "✗ NOT SET"}  ${k}`);
}
console.log(`   ${process.env.BREVO_API_KEY ? "✓" : "–  not set (forgot-password emails won't send)"}  BREVO_API_KEY`);
const sender = process.env.BREVO_FROM_EMAIL || process.env.EMAIL_USER;
console.log(`   ${sender ? "✓" : "–  not set (forgot-password emails won't send)"}  sender address (BREVO_FROM_EMAIL or EMAIL_USER)${sender ? `: ${sender}` : ""}`);
console.log(`   ${process.env.PORT ? "✓" : "–"}  PORT ${process.env.PORT || "(not set: the server uses 3000)"}`);

console.log("3. Loading the API");
try {
  require(path.join(root, "routes/Index"));
  require(path.join(root, "controllers/EsslController"));
  require(path.join(root, "services/attendanceRepair"));
  const r = require(path.join(root, "routes/attendanceAppRoutes"));
  const paths = r.stack.filter((l) => l.route).map((l) => l.route.path);
  console.log(`   ✓ loads; /api/attendance-app has ${paths.length} routes (${paths.join(", ")})`);
} catch (e) {
  ok = false;
  console.log(`   ✗ ${e.message.split("\n")[0]}`);
}

console.log(ok ? "\nAll good. Restart the server (for example: pm2 restart all) and reload the app."
  : "\nFix the ✗ items above (upload the missing files / set the values), run this again, then restart the server.");
process.exit(ok ? 0 : 1);
