/**
 * EsslController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all eSSL / ZKTeco fingerprint machine integration.
 *
 * eSSL F22 NOTE: this device sends EVERY punch as type "check-in" (it does not
 * distinguish in vs out). We therefore DON'T trust the punch type. We order all
 * distinct punches for the day and treat them as IN/OUT PAIRS:
 *   punch 1 → clock_in   (morning)
 *   punch 2 → out of a segment  (e.g. lunch-out)
 *   punch 3 → in of the next segment (e.g. lunch-in)
 *   ...
 *   last punch of the day → clock_out  ── ONLY when it qualifies as end-of-day.
 *
 * WHY THE MODEL CHANGED (the tracker "showed 4h for 7h worked" bug):
 *   The previous STRICT TWO-PUNCH model made the 2ND distinct punch the
 *   clock_out. For anyone who biometric-punches for lunch, that 2nd punch is the
 *   LUNCH-OUT (~1pm). The heartbeat then reported "clocked out", the desktop
 *   tracker stopped at lunch, and the whole afternoon went untracked.
 *   Now a mid-day punch NEVER sets clock_out: only a punch that is clearly
 *   end-of-day does (see isEndOfDayPunch below). Lunch simply becomes a break.
 *
 * "Distinct" still matters: the F22 frequently registers one finger-placement as
 * two records seconds/minutes apart (re-taps, device re-sends). Punches inside a
 * short burst window (ESSL_PUNCH_MERGE_WINDOW_MIN, default 10 min) are merged
 * into ONE punch.
 *
 * END-OF-DAY DETECTION (config via env):
 *   A trailing "out" punch is treated as the real clock_out when EITHER:
 *     (a) it happened at/after ESSL_EOD_AFTER_HOUR:ESSL_EOD_AFTER_MIN (IST),
 *         default 16:00 — so a ~1-2pm lunch-out never qualifies; OR
 *     (b) it has been "settled" for ESSL_CLOCKOUT_SETTLE_MIN minutes with no
 *         newer punch (default 120) — covers early leavers / half-days.
 *   Until a punch qualifies, clock_out stays null and the tracker keeps running.
 *
 * HOW fingerprint_id MAPS TO employees:
 *   Each employee must have their fingerprint_id set in the User document.
 *   Set it via PATCH /api/essl/assign-fingerprint  { user_id, fingerprint_id }
 */

const Attendance = require("../models/attendance");
const User = require("../models/users");
const { handleClockInAlert, handleClockOutAlert } = require("../services/attendanceAlerts");
const rules = require("../services/attendanceRules");
const UnmatchedPunch = require("../models/unmatchedPunch");
const EsslDevice = require("../models/esslDevice");

// ─── Machine tracking + command queue ────────────────────────────────────────
// Remember each machine (by serial) and when it last called in.
const touchDevice = (serial, ip, extra = {}) => {
  if (!serial) return Promise.resolve();
  return EsslDevice.updateOne(
    { serial: String(serial) },
    { $set: { last_seen: new Date(), last_ip: ip || "", ...extra } },
    { upsert: true }
  ).catch((e) => console.error("[eSSL] device update failed:", e.message));
};

// "Ver 6.60 Apr 2 2019,19,25,2345,192.168.1.201,..." → { firmware, users, fingerprints, punches, ip }
const parseDeviceInfo = (raw) => {
  if (!raw) return null;
  const p = String(raw).split(",").map((x) => x.trim());
  const num = (v) => (/^\d+$/.test(v || "") ? Number(v) : null);
  return { firmware: p[0] || "", users: num(p[1]), fingerprints: num(p[2]), punches: num(p[3]), ip: p[4] || "", raw: String(raw).slice(0, 200), at: new Date() };
};

// Parse "KEY=value\tKEY=value" (machine user lines) into an object.
const parseKV = (line) => Object.fromEntries(
  line.replace(/^USER\s+/, "").split("\t").map((kv) => {
    const i = kv.indexOf("=");
    return i > 0 ? [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()] : null;
  }).filter(Boolean)
);

// Store the users the machine reports (table OPERLOG "USER PIN=..." or USERINFO "PIN=...").
const storeMachineUsers = async (serial, rawBody) => {
  const users = [];
  for (const line of rawBody.split("\n")) {
    const t = line.trim();
    // "USER PIN=1\tName=…" (OPERLOG) or "PIN=1\tName=…" (USERINFO); skip FP/FACE templates
    if (!/^(USER\s+)?PIN2?=/i.test(t)) continue;
    const kv = parseKV(t);
    if (!kv.pin && kv.pin2) kv.pin = kv.pin2;
    if (!kv.pin) continue;
    users.push({ pin: String(kv.pin).trim(), name: kv.name || "", card: kv.card || "", privilege: kv.pri || kv.privilege || "" });
  }
  if (!users.length) return 0;
  const dev = (await EsslDevice.findOne({ serial: String(serial) })) || new EsslDevice({ serial: String(serial) });
  const byPin = new Map(dev.users.map((u) => [u.pin, u]));
  for (const u of users) byPin.set(u.pin, u); // update / add (the machine may send the list in parts)
  dev.users = [...byPin.values()].sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }));
  dev.users_updated_at = new Date();
  await dev.save();
  console.log(`[eSSL] 👥 ${users.length} user(s) received from machine ${serial} (${dev.users.length} known)`);
  return users.length;
};

/**
 * Many machines send the requested data but never post a separate confirmation
 * to /iclock/devicecmd. So when punches or users arrive, mark the matching
 * waiting request(s) as done, with what the machine sent.
 */
const completeCommands = async (serial, kind, result) => {
  try {
    const dev = await EsslDevice.findOne({ serial: String(serial) });
    if (!dev) return;
    const match = (c) => c.status === "sent" && (kind === "ATTLOG"
      ? c.cmd.startsWith("DATA QUERY ATTLOG") || c.cmd === "CHECK"
      : c.cmd.startsWith("DATA QUERY USERINFO") || c.cmd === "CHECK");
    let n = 0;
    for (const c of dev.commands) if (match(c)) { Object.assign(c, { status: "done", result, done_at: new Date() }); n++; }
    if (n) { await dev.save(); console.log(`[eSSL] ✅ ${n} request(s) for ${serial} completed by data: ${result}`); }
  } catch (e) { console.error("[eSSL] completeCommands:", e.message); }
};

/** Ask a machine to upload everything again (older-firmware method), then make it reconnect. */
const requestFullUpload = async (serial, by = "") => {
  await EsslDevice.updateOne({ serial: String(serial) },
    { $set: { resend_all: true, resend_all_requested_at: new Date(), resend_all_sent_at: null } });
  // CHECK makes most machines re-read the server options right away (the reconnect above)
  return queueDeviceCommand(serial, "CHECK", "Upload everything again (older method)", by);
};

/** Any other /iclock call from the machine: log it, remember it, answer OK. */
const unknownDeviceCall = async (req, res) => {
  const serial = req.query.SN;
  const what = `${req.method} ${req.path} ${JSON.stringify(req.query)} ${typeof req.body === "string" ? req.body.slice(0, 120) : ""}`.trim();
  console.log(`[eSSL] ❓ Unknown machine call: ${what}`);
  if (serial) {
    EsslDevice.updateOne({ serial: String(serial) }, { $push: { unknown_calls: { $each: [`${new Date().toISOString()} ${what}`], $slice: -20 } } }).catch(() => {});
  }
  res.set("Content-Type", "text/plain");
  res.send("OK");
};

/** Queue a command for a machine (picked up on its next poll). Used by the admin app. */
const queueDeviceCommand = async (serial, cmd, label, by = "") => {
  const dev = await EsslDevice.findOne({ serial: String(serial) });
  if (!dev) throw new Error(`Machine ${serial} hasn't contacted the server yet`);
  // Same request already waiting? Don't pile up duplicates.
  const pending = dev.commands.find((c) => c.cmd === cmd && (c.status === "queued" || c.status === "sent"));
  if (pending) return pending.id;
  const id = dev.next_cmd_id || 1;
  dev.next_cmd_id = id + 1;
  dev.commands.push({ id, cmd, label, created_by: by });
  if (dev.commands.length > 50) dev.commands = dev.commands.slice(-50);
  await dev.save();
  return id;
};

// ─── Shared Helpers ──────────────────────────────────────────────────────────

// FIX: the day a record belongs to is the IST calendar day, stored as 00:00 IST
// (same convention as Attendancecontroller). d.setHours(0,0,0,0) used the
// server's midnight, so on a UTC/CET server these records never matched the
// attendance controller's queries. See services/attendanceRules.js.
const toMidnight = (date = new Date()) => rules.istDayStart(date);

// Punches closer together than this are treated as ONE punch (device re-sends,
// employee re-taps because it didn't beep, etc.). 10 minutes is far below any
// real in→out gap but comfortably above re-tap noise. Override via env.
const PUNCH_MERGE_WINDOW_MIN = Number(process.env.ESSL_PUNCH_MERGE_WINDOW_MIN || 10);
const PUNCH_MERGE_WINDOW_MS = Math.max(0, PUNCH_MERGE_WINDOW_MIN) * 60 * 1000;

// Earliest local (IST) time a punch-out can count as the end-of-day clock_out.
const EOD_AFTER_HOUR = Number(process.env.ESSL_EOD_AFTER_HOUR || 16); // 4pm
const EOD_AFTER_MIN = Number(process.env.ESSL_EOD_AFTER_MIN || 0);
// If the last punch is older than this (no newer punch since), treat it as a
// finished day even if it's before the EOD hour (early leaver / half-day).
// Default 120 min — comfortably longer than any normal lunch, so a mid-day
// lunch-out never gets mistaken for the day's clock-out while the person is away.
const CLOCKOUT_SETTLE_MS = Math.max(0, Number(process.env.ESSL_CLOCKOUT_SETTLE_MIN || 120)) * 60 * 1000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ─── Device clock-sync policy (fixes the F22 "30-minutes-slow" bug) ──────────
// Controls whether — and how — the server sets the device clock during the
// ADMS handshake. The eSSL F22 firmware mishandles a fractional TimeZone (5.5):
// when it receives Date= together with TimeZone=5.5 it drops the half-hour and
// the clock ends up exactly 30 minutes slow. Options:
//   "off" (DEFAULT) → send NEITHER Date= NOR TimeZone=. The device keeps the
//                     correct local time from its own Time Zone menu (GMT+05:30).
//                     Safest: nothing on the wire can mangle the half-hour.
//   "utc"           → send Date= in UTC with TimeZone=0. The device's own menu
//                     timezone (GMT+05:30) does the display conversion, so the
//                     server can keep the clock corrected without ever putting a
//                     fractional timezone on the wire.
//   "ist"           → legacy: Date= in IST wall-clock + TimeZone=5.5. Only use
//                     if you've confirmed your firmware handles 5.5 correctly.
// NOTE: this does NOT affect how punches are parsed — admsReceiver always reads
// ATTLOG timestamps as IST (+05:30), independent of this setting.
const TIME_SYNC = String(process.env.ESSL_TIME_SYNC || "off").toLowerCase();

// Format a Date's UTC components as "YYYY-MM-DD HH:MM:SS" (no timezone shift).
const fmtClock = (d) =>
  [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-") +
  " " +
  [
    String(d.getUTCHours()).padStart(2, "0"),
    String(d.getUTCMinutes()).padStart(2, "0"),
    String(d.getUTCSeconds()).padStart(2, "0"),
  ].join(":");

// Minutes-since-midnight in IST for a UTC instant.
const istMinutes = (date) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const calcHours = (clockIn, clockOut) =>
  Math.round(((clockOut - clockIn) / (1000 * 60 * 60)) * 100) / 100;

// FIX: status follows the ACTIVE Policy (work start + late grace, half-day
// hours, weekly offs, holidays) instead of a hard-coded 09:15 / 4 h.
// upsertAttendanceFromPunches() loads the policy before calling this.
const deriveStatus = (clockIn, workedHours = null) => rules.deriveStatus(clockIn, workedHours);

// Would this trailing punch, given the current time, count as end-of-day?
const isEndOfDayPunch = (punchTime, now = new Date()) => {
  const mins = istMinutes(punchTime);
  const afterEodHour = mins >= EOD_AFTER_HOUR * 60 + EOD_AFTER_MIN;
  const settled = now - new Date(punchTime).getTime() >= CLOCKOUT_SETTLE_MS;
  return afterEodHour || settled;
};

const decodePunchType = (typeCode) => {
  const map = {
    "0": "check-in",
    "1": "check-out",
    "2": "break-out",
    "3": "break-in",
    "4": "overtime-in",
    "5": "overtime-out",
  };
  return map[String(typeCode)] || "check-in";
};

const decodeVerifyMethod = (verifyCode) => {
  const map = { "1": "fingerprint", "3": "password", "11": "face", "15": "card" };
  return map[String(verifyCode)] || "fingerprint";
};

// Given the ordered distinct punches, roll them up into work segments and derive
// clock_in / clock_out / worked / break totals.
//   segments = [[in,out],[in,out],...]; a trailing lone punch = open segment.
//   clock_out is only set when the LAST punch is (a) an "out" (even count) AND
//   (b) qualifies as end-of-day. Otherwise the person is still on the clock
//   (working or on a break) and clock_out stays null.
const deriveFromDistinct = (distinct, now = new Date()) => {
  const clock_in = new Date(distinct[0].time);
  const even = distinct.length % 2 === 0;
  const lastPunch = distinct[distinct.length - 1].time;

  let clock_out = null;
  if (distinct.length >= 2 && even && isEndOfDayPunch(lastPunch, now)) {
    clock_out = new Date(lastPunch);
  }

  // Sum completed work segments and the gaps between them (breaks).
  // Only count pairs up to the finalized clock_out; if still on the clock, the
  // last (open) punch is left out of worked/breaks.
  const usable = clock_out ? distinct.length : distinct.length - (even ? 0 : 1);
  let workedMs = 0;
  let breakMs = 0;
  for (let i = 0; i + 1 < usable; i += 2) {
    workedMs += distinct[i + 1].time - distinct[i].time;
    if (i + 2 < usable) breakMs += distinct[i + 2].time - distinct[i + 1].time;
  }

  const hours_worked = clock_out ? Math.round((workedMs / 3600000) * 100) / 100 : null;
  const break_minutes = Math.round(breakMs / 60000);
  const status = deriveStatus(clock_in, hours_worked);

  return { clock_in, clock_out, hours_worked, break_minutes, status };
};

/**
 * Core function: given new punch events for one employee on one day, merge them
 * with any punches already stored for that day, de-duplicate, and recompute
 * clock_in / clock_out using the pairs + end-of-day model described up top.
 */
const upsertAttendanceFromPunches = async (user, dateObj, punches, deviceSerial) => {
  await rules.loadRules(); // current policy for deriveStatus (cached 60 s)
  const userId = user._id;
  const date = toMidnight(dateObj);

  // 1. Load punches already stored for this user/day (full-day picture).
  //    FIX: look across the whole IST day, not one exact date value. Records
  //    saved by the old code sit at a different midnight; without this, a day
  //    got split in two (morning punch in one record, evening punch in another)
  //    and both showed "punched in, no punch out". All punches are merged into
  //    one record and the split copies are removed.
  const dayRecs = await Attendance.find({ user_id: userId, date: rules.istDayRange(date) }).sort({ createdAt: 1 });
  const existing =
    dayRecs.find((r) => r.admin_locked) ||           // an admin's marking wins
    dayRecs.find((r) => +r.date === +date) ||        // already on the right midnight
    dayRecs.find((r) => r.raw_logs?.length) ||
    dayRecs[0] || null;
  const splitCopies = dayRecs.filter((r) => r !== existing && (r.source === "fingerprint" || r.raw_logs?.length));
  const priorLogs = [...(existing?.raw_logs || []), ...splitCopies.flatMap((r) => r.raw_logs || [])];

  // 2. Merge prior + incoming punches. Incoming first, so when the device
  //    re-sends a punch the newly corrected copy wins over an older stored one.
  const incoming = punches.map((p) => ({
    time: new Date(p.time),
    type: String(p.type),
    verify: String(p.verify),
    clock_offset_applied: Number(p.clock_offset_applied) || 0,
  }));
  const merged = [
    ...incoming,
    ...priorLogs.map((l) => ({
      time: new Date(l.time),
      type: String(l.type),
      verify: String(l.verify),
      ...(l.clock_offset_applied != null && { clock_offset_applied: l.clock_offset_applied }),
    })),
  ];

  // 3. De-duplicate (the device re-sends the same punches). Compare on the
  //    machine's own clock reading — stored time minus the correction it got —
  //    so a re-sent punch never appears twice, corrected and uncorrected.
  const seen = new Set();
  const allPunches = [];
  for (const p of merged) {
    const key = p.time.getTime() - (Number(p.clock_offset_applied) || 0) * 60 * 1000;
    if (Number.isNaN(key) || seen.has(key)) continue;
    seen.add(key);
    allPunches.push(p);
  }

  // 4. Sort chronologically.
  allPunches.sort((a, b) => a.time - b.time);
  if (!allPunches.length) return null;

  // 5. Merge punch BURSTS: any punch within PUNCH_MERGE_WINDOW_MS of the last
  //    kept punch is the same physical punch (re-tap / device re-send), not a
  //    new event.
  const distinct = [];
  for (const p of allPunches) {
    const last = distinct[distinct.length - 1];
    if (last && p.time - last.time < PUNCH_MERGE_WINDOW_MS) continue;
    distinct.push(p);
  }

  // 6. Pairs + end-of-day derivation (lunch pairs never set clock_out).
  const { clock_in, clock_out, hours_worked, break_minutes, status } =
    deriveFromDistinct(distinct, new Date());

  // 7. Save the full deduped set with $set (NOT $push — avoids duplicate pile-up).
  //    If an admin marked this day (admin_locked), keep their times/status/source
  //    and only log the punches.
  const update = existing?.admin_locked
    ? { raw_logs: allPunches, device_serial: deviceSerial || null }
    : {
        clock_in,
        clock_out,
        hours_worked,
        break_minutes,
        status,
        source: "fingerprint",
        device_serial: deviceSerial || null,
        raw_logs: allPunches,
      };
  const record = await Attendance.findOneAndUpdate(
    existing ? { _id: existing._id } : { user_id: userId, date },
    {
      $set: { ...update, date }, // always stored at 00:00 IST
    },
    { upsert: true, returnDocument: "after", runValidators: true }
  );
  if (splitCopies.length) {
    await Attendance.deleteMany({ _id: { $in: splitCopies.map((r) => r._id) } });
    console.log(`[eSSL] Merged ${splitCopies.length} split record(s) for ${user.name} on ${rules.istDateKey(date)}`);
  }

  // ─── Fire attendance alerts on state transitions ─────────────────────────
  // Login ping: only when this is the first punch of the day (record is new).
  if (!existing) {
    handleClockInAlert(record, user).catch(() => {});
  }
  // Overtime/clock-out alert: only when a real end-of-day clock-out was just
  // derived (wasn't set before). Lunch punches don't reach here anymore.
  if (record.clock_out && !existing?.clock_out) {
    handleClockOutAlert(record, user).catch(() => {});
  }

  return record;
};

// ─── Who does a punch belong to? ─────────────────────────────────────────────
// The machine sends its own user number for every punch ("Device ID").
// 1st: the user whose fingerprint_id equals it.
// 2nd: if nobody has that fingerprint_id, the user whose employee_id equals it
//      (for machines enrolled with employee codes). Email is never used.
const findUsersForDeviceIds = async (ids) => {
  const list = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
  const users = await User.find({ $or: [{ fingerprint_id: { $in: list } }, { employee_id: { $in: list } }] });
  const byFp = new Map(), byEmp = new Map();
  for (const u of users) {
    if (u.fingerprint_id) byFp.set(String(u.fingerprint_id).trim(), u);
    if (u.employee_id) byEmp.set(String(u.employee_id).trim(), u);
  }
  const map = new Map();
  for (const id of list) {
    const u = byFp.get(id) || byEmp.get(id);
    if (u) map.set(id, u);
  }
  return map;
};

// ─── Punches nobody owns yet ─────────────────────────────────────────────────
// Kept (instead of dropped) until an admin assigns the Device ID to someone.
const keepUnmatched = async (deviceId, punches, deviceSerial) => {
  try {
    if (!punches.length) return;
    const times = punches.map((p) => new Date(p.time)).sort((a, b) => a - b);
    const doc = (await UnmatchedPunch.findOne({ device_id: deviceId })) || new UnmatchedPunch({ device_id: deviceId, first_seen: times[0] });
    const known = new Set(doc.punches.map((p) => +new Date(p.time) - (p.clock_offset_applied || 0) * 60000));
    for (const p of punches) {
      const key = +new Date(p.time) - (Number(p.clock_offset_applied) || 0) * 60000;
      if (known.has(key)) continue; // device re-sent it
      known.add(key);
      doc.punches.push({ time: p.time, type: p.type, verify: p.verify, clock_offset_applied: p.clock_offset_applied, device_serial: deviceSerial || null });
      doc.count += 1;
    }
    doc.punches.sort((a, b) => a.time - b.time);
    if (doc.punches.length > UnmatchedPunch.MAX_KEPT) doc.punches = doc.punches.slice(-UnmatchedPunch.MAX_KEPT);
    if (!doc.first_seen || times[0] < doc.first_seen) doc.first_seen = times[0];
    if (!doc.last_seen || times[times.length - 1] > doc.last_seen) doc.last_seen = times[times.length - 1];
    await doc.save();
  } catch (err) {
    console.error(`[eSSL] could not keep unmatched punches for Device ID ${deviceId}:`, err.message);
  }
};

/**
 * Imports the kept punches of `deviceId` into `user`'s attendance (grouped by
 * IST day, same processing as live punches) and forgets them.
 * Returns { punches, days }.
 */
const importUnmatchedPunches = async (deviceId, user) => {
  const doc = await UnmatchedPunch.findOne({ device_id: String(deviceId).trim() });
  if (!doc || !doc.punches.length) return { punches: 0, days: 0 };
  const byDay = new Map();
  for (const p of doc.punches) {
    const day = rules.istDateKey(p.time);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ time: p.time, type: p.type, verify: p.verify, clock_offset_applied: p.clock_offset_applied });
  }
  for (const [day, punches] of byDay) {
    await upsertAttendanceFromPunches(user, rules.istDayStart(day), punches, doc.punches[0].device_serial);
  }
  const n = doc.punches.length;
  await doc.deleteOne();
  console.log(`[eSSL] Imported ${n} earlier punches of Device ID ${deviceId} into ${user.name} (${byDay.size} days)`);
  return { punches: n, days: byDay.size };
};

// ─── METHOD 1: ADMS PUSH RECEIVER ────────────────────────────────────────────

const admsHandshake = async (req, res) => {
  try {
    const { SN } = req.query;
    await touchDevice(SN, req.ip, { last_handshake_at: new Date(), last_handshake_query: JSON.stringify(req.query).slice(0, 400) });
    const dev = SN ? await EsslDevice.findOne({ serial: String(SN) }).catch(() => null) : null;
    console.log(`[eSSL] ✅ Device handshake — Serial: ${SN} | IP: ${req.ip} | Query: ${JSON.stringify(req.query)} | TIME_SYNC=${TIME_SYNC}`);

    // Base options. TransTimes/TransFlag/Realtime tell the device WHAT and WHEN
    // to push; they don't touch the clock. The clock lines (TimeZone/Date) are
    // appended conditionally below so the F22 can't mangle the +5:30 half-hour.
    const options = [
      `GET OPTION FROM: ${SN}`,
      "ATTSTAMP",
      "ErrorDelay=30",
      "Delay=10",
      "TransTimes=00:00;00:30;01:00;01:30;02:00;02:30;03:00;03:30;04:00;04:30;05:00;05:30;06:00;06:30;07:00;07:30;08:00;08:30;09:00;09:30;10:00;10:30;11:00;11:30;12:00;12:30;13:00;13:30;14:00;14:30;15:00;15:30;16:00;16:30;17:00;17:30;18:00;18:30;19:00;19:30;20:00;20:30;21:00;21:30;22:00;22:30;23:00;23:30",
      "TransInterval=1",
      "TransFlag=TransData AttLog OpLog EnrollUser",
      "Realtime=1",
      "Encrypt=0",
      "ServerVer=2.4",
      "TableNameFix=0",
    ];

    if (TIME_SYNC === "utc") {
      // Give the device UTC + a whole-number timezone (0). The device's own menu
      // timezone (GMT+05:30) then renders the correct local time. No fractional
      // timezone ever crosses the wire, so the half-hour can't be dropped.
      options.push("TimeZone=0");
      options.push(`Date=${fmtClock(new Date())}`);
    } else if (TIME_SYNC === "ist") {
      // Legacy behaviour — only correct on firmware that parses 5.5 properly.
      options.push("TimeZone=5.5");
      options.push(`Date=${fmtClock(new Date(Date.now() + IST_OFFSET_MS))}`);
    }
    // "off" (default): send neither TimeZone nor Date. The device keeps the
    // correct local time from its own Time Zone menu and is never overridden.

    // "Upload everything again": stamps of 0 make the machine re-send its whole
    // attendance log and its users (operation log). Works on old and new firmware.
    if (dev?.resend_all) {
      options.push("ATTLOGStamp=0", "OPERLOGStamp=0");
      await EsslDevice.updateOne({ _id: dev._id }, { $set: { resend_all_sent_at: new Date() } });
      console.log(`[eSSL] 🔁 Asked machine ${SN} to upload ALL punches and users again (stamps reset)`);
    }

    res.set("Content-Type", "text/plain");
    res.send(options.join("\n") + "\n");
  } catch (err) {
    console.error("[eSSL] Handshake error:", err);
    res.status(500).send("ERROR");
  }
};

// The machine polls this every few seconds. Answer with the next queued command
// ("C:<id>:<command>") or "OK" when there's nothing to do.
const getRequest = async (req, res) => {
  res.set("Content-Type", "text/plain");
  try {
    const serial = req.query.SN;
    if (!serial) return res.send("OK");
    // Most eSSL/ZK machines report their own totals on this call:
    // INFO=firmware,users,fingerprints,punches,ip,... → lets the app show what's complete.
    const info = parseDeviceInfo(req.query.INFO);
    await touchDevice(serial, req.ip, info ? { info } : {});
    const dev = await EsslDevice.findOne({ serial: String(serial) });
    if (!dev) return res.send("OK");
    // Give up on requests the machine never answered within 30 min (its firmware may not support them)
    let changed = false;
    for (const c of dev.commands) {
      if (c.status === "sent" && c.sent_at && Date.now() - c.sent_at > 30 * 60 * 1000) {
        Object.assign(c, { status: "failed", result: "No reply from the machine", done_at: new Date() });
        changed = true;
      }
    }
    // Next queued command; or retry once a command sent 10+ min ago that got no data back
    const stale = Date.now() - 10 * 60 * 1000;
    const next = dev.commands.find((c) => c.status === "queued") ||
      dev.commands.find((c) => c.status === "sent" && c.sent_at < stale && !c.result && (c.attempts || 1) < 2 && c.cmd !== "REBOOT");
    if (!next) { if (changed) await dev.save(); return res.send("OK"); }
    next.status = "sent";
    next.sent_at = new Date();
    next.attempts = (next.attempts || 0) + 1;
    await dev.save();
    console.log(`[eSSL] 📤 Command ${next.id} → ${serial}: ${next.cmd.replace(/\t/g, " ")}`);
    return res.send(`C:${next.id}:${next.cmd}\n`);
  } catch (err) {
    console.error("[eSSL] getrequest error:", err.message);
    return res.send("OK");
  }
};

// The machine confirms commands here: body lines like "ID=3&Return=0&CMD=DATA".
const deviceCmd = async (req, res) => {
  res.set("Content-Type", "text/plain");
  try {
    const serial = req.query.SN;
    // Body is "ID=3&Return=0&CMD=DATA" lines (text), or already parsed into an object
    // when the machine sends it form-encoded.
    const answers = typeof req.body === "string"
      ? req.body.split(/\n/).map((line) => Object.fromEntries(line.trim().split("&").map((p) => p.split("=")).filter((x) => x.length === 2)))
      : req.body && typeof req.body === "object" ? [req.body] : [];
    const dev = serial && (await EsslDevice.findOne({ serial: String(serial) }));
    if (dev) {
      for (const q of answers) {
        const c = dev.commands.find((x) => String(x.id) === String(q.ID));
        if (!c) continue;
        const ret = Number(q.Return);
        c.status = Number.isFinite(ret) && ret < 0 ? "failed" : "done";
        c.result = `Return=${q.Return ?? "?"}`;
        c.done_at = new Date();
        console.log(`[eSSL] ✅ Machine ${serial} answered command ${c.id}: ${c.result}`);
      }
      await dev.save();
    }
  } catch (err) {
    console.error("[eSSL] devicecmd error:", err.message);
  }
  return res.send("OK");
};

const admsReceiver = async (req, res) => {
  try {
    const { SN: deviceSerial, table } = req.query;

    const rawBody =
      typeof req.body === "string" ? req.body
      : Buffer.isBuffer(req.body) ? req.body.toString("utf8")
      : req.body && typeof req.body === "object" && Object.keys(req.body).length
        ? Object.entries(req.body).map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join("&") // form-parsed: rebuild
        : "";

    console.log(`[eSSL] 📥 POST /iclock/cdata — Device: ${deviceSerial} | Table: ${table} | Body length: ${rawBody.length}`);

    touchDevice(deviceSerial, req.ip);
    // The full re-upload has started arriving: stop asking for it at every connection
    if (table === "ATTLOG" || table === "OPERLOG") {
      EsslDevice.updateOne({ serial: String(deviceSerial), resend_all: true, resend_all_sent_at: { $ne: null } },
        { $set: { resend_all: false } }).catch(() => {});
    }
    if (table === "OPERLOG" || table === "USERINFO" || table === "OPLOG") {
      const n = await storeMachineUsers(deviceSerial, rawBody).catch((e) => { console.error("[eSSL] users:", e.message); return 0; });
      if (n) await completeCommands(deviceSerial, "USERS", `Machine sent ${n} user${n === 1 ? "" : "s"}`);
      if (!n) console.log(`[eSSL] ⏭ ${table} from ${deviceSerial} (no user lines)`);
      res.set("Content-Type", "text/plain");
      return res.send("OK");
    }
    if (table !== "ATTLOG") {
      console.log(`[eSSL] ⏭ Ignoring table: ${table} from device ${deviceSerial}`);
      res.set("Content-Type", "text/plain");
      return res.send("OK");
    }

    if (!rawBody.trim()) {
      res.set("Content-Type", "text/plain");
      return res.send("OK");
    }

    console.log(`[eSSL] Received ATTLOG from device ${deviceSerial}:\n${rawBody}`);

    const lines = rawBody.trim().split("\n").filter(Boolean);
    const punchMap = new Map(); // key: "fingerprint_id::YYYY-MM-DD" → [punches]
    const clockRules = await rules.loadRules(); // for the machine clock correction

    for (const line of lines) {
      const parts = line.trim().split(/\t|\s{2,}/);
      if (parts.length < 2) continue;

      const [fingerprintId, datetimeStr, typeCode = "0", verifyCode = "1"] = parts;
      // Device sends local IST time (TimeZone=5.5). Parse as IST -> correct UTC.
      const deviceTime = new Date(datetimeStr.trim().replace(" ", "T") + "+05:30");
      if (isNaN(deviceTime)) continue;
      // Machine clock correction from the Policy (e.g. +30 min when the machine runs behind)
      const punchTime = rules.correctDeviceTime(deviceTime, clockRules);

      const dateKey = rules.istDateKey(punchTime); // FIX: IST day, not UTC day (punches before 05:30 IST were filed under the previous day)
      const mapKey = `${fingerprintId}::${dateKey}`;

      if (!punchMap.has(mapKey)) punchMap.set(mapKey, []);
      punchMap.get(mapKey).push({
        fingerprintId: String(fingerprintId).trim(),
        time: punchTime,
        type: decodePunchType(typeCode),
        verify: decodeVerifyMethod(verifyCode),
        clock_offset_applied: clockRules.deviceClockOffsetMinutes,
        dateKey,
      });
    }

    const fingerprintIds = [...new Set([...punchMap.keys()].map((k) => k.split("::")[0]))];

    // Device ID → fingerprint_id first, then employee_id (see findUsersForDeviceIds)
    const userByFpId = await findUsersForDeviceIds(fingerprintIds);

    const results = { saved: 0, skipped: 0, errors: [] };

    for (const [mapKey, punches] of punchMap) {
      const [fpId, dateStr] = mapKey.split("::");
      const user = userByFpId.get(fpId);

      if (!user) {
        console.warn(`[eSSL] ⚠️  No user with Device ID (fingerprint_id) or Employee ID "${fpId}" — punch kept as unassigned. Assign it in the admin app (IDs).`);
        await keepUnmatched(fpId, punches, deviceSerial);
        results.skipped++;
        continue;
      }

      try {
        await upsertAttendanceFromPunches(user, new Date(dateStr), punches, deviceSerial);
        results.saved++;
        console.log(`[eSSL] Saved attendance for ${user.name} (fp:${fpId}) on ${dateStr}`);
      } catch (err) {
        results.errors.push({ fpId, dateStr, error: err.message });
        console.error(`[eSSL] Error saving for fp:${fpId} on ${dateStr}:`, err.message);
      }
    }

    touchDevice(deviceSerial, req.ip, { last_punches_at: new Date(), last_punches_count: lines.length });
    await completeCommands(deviceSerial, "ATTLOG", `Machine sent ${lines.length} punch${lines.length === 1 ? "" : "es"}`);
    console.log(`[eSSL] Batch complete — saved:${results.saved} skipped:${results.skipped} errors:${results.errors.length}`);

    res.set("Content-Type", "text/plain");
    res.send("OK");
  } catch (err) {
    console.error("[eSSL] Fatal ADMS receiver error:", err);
    res.set("Content-Type", "text/plain");
    res.send("ERROR");
  }
};

// ─── METHOD 2: TCP PULL SYNC ─────────────────────────────────────────────────

const syncFromDevice = async (req, res) => {
  let ZKLib;
  try {
    ZKLib = require("node-zklib");
  } catch {
    return res.status(501).json({
      success: false,
      message: "TCP pull requires the node-zklib package. Run: npm install node-zklib",
    });
  }

  const { ip, port = 4370, device_serial } = req.body;

  if (!ip) {
    return res.status(400).json({ success: false, message: "Device IP is required" });
  }

  let zkInstance;
  try {
    zkInstance = new ZKLib(ip, port, 10000, 4000);
    await zkInstance.createSocket();

    console.log(`[eSSL] Connected to device at ${ip}:${port}`);

    const { data: logs } = await zkInstance.getAttendances();

    if (!logs || logs.length === 0) {
      await zkInstance.disconnect();
      return res.status(200).json({ success: true, message: "No logs found on device", saved: 0 });
    }

    console.log(`[eSSL] Pulled ${logs.length} punch records from device`);

    const punchMap = new Map();
    const clockRules = await rules.loadRules(); // for the machine clock correction

    for (const log of logs) {
      const fpId = String(log.deviceUserId);
      // FIX: node-zklib returns the device's IST wall-clock as SERVER-local time;
      // re-read it as IST so it's correct on any server timezone.
      // ...then apply the machine clock correction from the Policy.
      const punchTime = rules.correctDeviceTime(rules.deviceLocalToInstant(log.recordTime), clockRules);
      const dateKey = rules.istDateKey(punchTime); // FIX: IST day, not UTC day (punches before 05:30 IST were filed under the previous day)
      const mapKey = `${fpId}::${dateKey}`;

      if (!punchMap.has(mapKey)) punchMap.set(mapKey, []);
      punchMap.get(mapKey).push({
        fingerprintId: fpId,
        time: punchTime,
        type: decodePunchType(log.inOutStatus),
        verify: "fingerprint",
        clock_offset_applied: clockRules.deviceClockOffsetMinutes,
        dateKey,
      });
    }

    await zkInstance.disconnect();

    const fingerprintIds = [...new Set([...punchMap.keys()].map((k) => k.split("::")[0]))];
    // Device ID → fingerprint_id first, then employee_id (see findUsersForDeviceIds)
    const userByFpId = await findUsersForDeviceIds(fingerprintIds);

    const results = { saved: 0, skipped: 0, errors: [] };

    for (const [mapKey, punches] of punchMap) {
      const [fpId, dateStr] = mapKey.split("::");
      const user = userByFpId.get(fpId);

      if (!user) {
        await keepUnmatched(fpId, punches, device_serial || ip);
        results.skipped++;
        continue;
      }

      try {
        await upsertAttendanceFromPunches(user, new Date(dateStr), punches, device_serial || ip);
        results.saved++;
      } catch (err) {
        results.errors.push({ fpId, dateStr, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Sync complete`,
      total_logs: logs.length,
      ...results,
    });
  } catch (err) {
    if (zkInstance) {
      try { await zkInstance.disconnect(); } catch {}
    }
    console.error("[eSSL] TCP sync error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── ASSIGN FINGERPRINT ID TO USER ───────────────────────────────────────────

const assignFingerprintId = async (req, res) => {
  try {
    const { user_id, fingerprint_id } = req.body;

    if (!user_id || !fingerprint_id) {
      return res.status(400).json({ success: false, message: "user_id and fingerprint_id are required" });
    }

    const existing = await User.findOne({
      fingerprint_id: String(fingerprint_id).trim(),
      _id: { $ne: user_id },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: `fingerprint_id "${fingerprint_id}" is already assigned to ${existing.name}`,
      });
    }

    const user = await User.findByIdAndUpdate(
      user_id,
      { fingerprint_id: String(fingerprint_id).trim() },
      { returnDocument: "after" }
    ).select("-password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      message: `Fingerprint ID "${fingerprint_id}" assigned to ${user.name}`,
      data: user,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getFingerprintMap = async (req, res) => {
  try {
    const users = await User.find({}, "name email department designation fingerprint_id status");
    return res.status(200).json({ success: true, data: users });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Device config + reachability ────────────────────────────────────────────

/**
 * GET /essl/device-config
 * Returns the device IP/port from the backend .env so the admin UI can
 * pre-fill the sync form instead of the admin retyping it each time.
 * Env: DEVICE_IP, DEVICE_PORT (or ESSL_DEVICE_IP / ESSL_DEVICE_PORT).
 */
const getDeviceConfig = async (req, res) => {
  try {
    const ip = process.env.DEVICE_IP || process.env.ESSL_DEVICE_IP || "";
    const port = Number(process.env.DEVICE_PORT || process.env.ESSL_DEVICE_PORT || 4370);
    const serial = process.env.DEVICE_SERIAL || process.env.ESSL_DEVICE_SERIAL || null;

    return res.status(200).json({
      success: true,
      data: {
        ip,
        port,
        device_serial: serial,
        configured: Boolean(ip),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /essl/ping   { ip, port }
 * Opens a short TCP connection to the device to confirm it is reachable from
 * the server. Always 200 — `data.reachable` carries the result so the UI can
 * show a status pill rather than treating unreachable as a request failure.
 */
const pingDevice = async (req, res) => {
  const net = require("net");

  const ip = req.body?.ip || process.env.DEVICE_IP || process.env.ESSL_DEVICE_IP;
  const port = Number(req.body?.port || process.env.DEVICE_PORT || 4370);
  const timeoutMs = Math.max(1000, Number(process.env.ESSL_PING_TIMEOUT_MS || 5000));

  if (!ip) {
    return res.status(400).json({ success: false, message: "Device IP is required" });
  }

  const result = await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable, message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, message });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `Device reachable at ${ip}:${port}`));
    socket.once("timeout", () =>
      finish(false, `No response from ${ip}:${port} within ${timeoutMs / 1000}s`)
    );
    socket.once("error", (err) =>
      finish(false, `Cannot reach ${ip}:${port} — ${err.code || err.message}`)
    );

    socket.connect(port, ip);
  });

  return res.status(200).json({
    success: true,
    data: { ip, port, ...result },
    ...result,
  });
};

module.exports = {
  admsHandshake,
  getRequest,
  admsReceiver,
  syncFromDevice,
  assignFingerprintId,
  getFingerprintMap,
  getDeviceConfig,
  pingDevice,
  // Used by scripts/fixAttendanceDates.js to re-derive stored days the same way.
  importUnmatchedPunches,
  deviceCmd,
  queueDeviceCommand,
  requestFullUpload,
  unknownDeviceCall,
  _internals: { deriveFromDistinct, PUNCH_MERGE_WINDOW_MS },
};
