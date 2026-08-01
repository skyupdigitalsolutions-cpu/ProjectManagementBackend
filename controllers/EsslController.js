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

// ─── Shared Helpers ──────────────────────────────────────────────────────────

const toMidnight = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

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

// Minutes-since-midnight in IST for a UTC instant.
const istMinutes = (date) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const calcHours = (clockIn, clockOut) =>
  Math.round(((clockOut - clockIn) / (1000 * 60 * 60)) * 100) / 100;

// Half-day if worked < 4h; late if the first punch is after 09:15 IST.
const deriveStatus = (clockIn, workedHours = null) => {
  if (workedHours != null && workedHours < 4) return "half-day";
  if (istMinutes(clockIn) > 9 * 60 + 15) return "late";
  return "present";
};

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
  const userId = user._id;
  const date = toMidnight(dateObj);

  // 1. Load punches already stored for this user/day (full-day picture).
  const existing = await Attendance.findOne({ user_id: userId, date });
  const priorLogs = existing?.raw_logs || [];

  // 2. Merge prior + incoming punches.
  const incoming = punches.map((p) => ({
    time: new Date(p.time),
    type: String(p.type),
    verify: String(p.verify),
  }));
  const merged = [
    ...priorLogs.map((l) => ({
      time: new Date(l.time),
      type: String(l.type),
      verify: String(l.verify),
    })),
    ...incoming,
  ];

  // 3. De-duplicate by exact timestamp (the device re-sends the same punches).
  const seen = new Set();
  const allPunches = [];
  for (const p of merged) {
    const key = p.time.getTime();
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
  const record = await Attendance.findOneAndUpdate(
    { user_id: userId, date },
    {
      $set: {
        clock_in,
        clock_out,
        hours_worked,
        break_minutes,
        status,
        source: "fingerprint",
        device_serial: deviceSerial || null,
        raw_logs: allPunches,
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true }
  );

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

// ─── METHOD 1: ADMS PUSH RECEIVER ────────────────────────────────────────────

const admsHandshake = async (req, res) => {
  try {
    const { SN } = req.query;
    console.log(`[eSSL] ✅ Device handshake — Serial: ${SN} | IP: ${req.ip} | Query: ${JSON.stringify(req.query)}`);

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

    res.set("Content-Type", "text/plain");
    res.send(`GET OPTION FROM: ${SN}\nATTSTAMP\nErrorDelay=30\nDelay=10\nTransTimes=00:00;00:30;01:00;01:30;02:00;02:30;03:00;03:30;04:00;04:30;05:00;05:30;06:00;06:30;07:00;07:30;08:00;08:30;09:00;09:30;10:00;10:30;11:00;11:30;12:00;12:30;13:00;13:30;14:00;14:30;15:00;15:30;16:00;16:30;17:00;17:30;18:00;18:30;19:00;19:30;20:00;20:30;21:00;21:30;22:00;22:30;23:00;23:30\nTransInterval=1\nTransFlag=TransData AttLog OpLog EnrollUser\nTimeZone=5.5\nRealtime=1\nEncrypt=0\nServerVer=2.4\nTableNameFix=0\nDate=${timestamp}\n`);
  } catch (err) {
    console.error("[eSSL] Handshake error:", err);
    res.status(500).send("ERROR");
  }
};

const getRequest = (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send("OK");
};

const admsReceiver = async (req, res) => {
  try {
    const { SN: deviceSerial, table } = req.query;

    const rawBody =
      typeof req.body === "string" ? req.body : req.body?.toString?.() || "";

    console.log(`[eSSL] 📥 POST /iclock/cdata — Device: ${deviceSerial} | Table: ${table} | Body length: ${rawBody.length}`);

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

    for (const line of lines) {
      const parts = line.trim().split(/\t|\s{2,}/);
      if (parts.length < 2) continue;

      const [fingerprintId, datetimeStr, typeCode = "0", verifyCode = "1"] = parts;
      // Device sends local IST time (TimeZone=5.5). Parse as IST -> correct UTC.
      const punchTime = new Date(datetimeStr.trim().replace(" ", "T") + "+05:30");
      if (isNaN(punchTime)) continue;

      const dateKey = punchTime.toISOString().slice(0, 10);
      const mapKey = `${fingerprintId}::${dateKey}`;

      if (!punchMap.has(mapKey)) punchMap.set(mapKey, []);
      punchMap.get(mapKey).push({
        fingerprintId: String(fingerprintId).trim(),
        time: punchTime,
        type: decodePunchType(typeCode),
        verify: decodeVerifyMethod(verifyCode),
        dateKey,
      });
    }

    const fingerprintIds = [...new Set([...punchMap.keys()].map((k) => k.split("::")[0]))];

    const users = await User.find({ fingerprint_id: { $in: fingerprintIds } });
    const userByFpId = new Map(users.map((u) => [String(u.fingerprint_id), u]));

    const results = { saved: 0, skipped: 0, errors: [] };

    for (const [mapKey, punches] of punchMap) {
      const [fpId, dateStr] = mapKey.split("::");
      const user = userByFpId.get(fpId);

      if (!user) {
        console.warn(`[eSSL] ⚠️  No user with fingerprint_id="${fpId}" — punch skipped. Run PATCH /api/essl/assign-fingerprint to map this ID.`);
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

    for (const log of logs) {
      const fpId = String(log.deviceUserId);
      const punchTime = new Date(log.recordTime);
      const dateKey = punchTime.toISOString().slice(0, 10);
      const mapKey = `${fpId}::${dateKey}`;

      if (!punchMap.has(mapKey)) punchMap.set(mapKey, []);
      punchMap.get(mapKey).push({
        fingerprintId: fpId,
        time: punchTime,
        type: decodePunchType(log.inOutStatus),
        verify: "fingerprint",
        dateKey,
      });
    }

    await zkInstance.disconnect();

    const fingerprintIds = [...new Set([...punchMap.keys()].map((k) => k.split("::")[0]))];
    const users = await User.find({ fingerprint_id: { $in: fingerprintIds } });
    const userByFpId = new Map(users.map((u) => [String(u.fingerprint_id), u]));

    const results = { saved: 0, skipped: 0, errors: [] };

    for (const [mapKey, punches] of punchMap) {
      const [fpId, dateStr] = mapKey.split("::");
      const user = userByFpId.get(fpId);

      if (!user) {
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
};