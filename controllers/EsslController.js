/**
 * EsslController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all eSSL / ZKTeco fingerprint machine integration.
 *
 * TWO METHODS SUPPORTED:
 *
 * 1. ADMS PUSH (Recommended — device sends data to your server automatically)
 *    The eSSL machine is configured with your server URL. It pushes attendance
 *    logs to POST /api/essl/adms every time someone punches in/out.
 *
 * 2. TCP PULL (Manual sync — your server connects to the device and pulls logs)
 *    Admin triggers POST /api/essl/sync with the device IP. Requires the
 *    `node-zklib` npm package (see README).
 *
 * SETUP STEPS:
 *   npm install node-zklib     ← only needed for TCP pull method
 *
 * HOW fingerprint_id MAPS TO employees:
 *   Each employee must have their fingerprint_id set in the User document.
 *   This is the same ID they were enrolled with on the device (e.g., "1", "42").
 *   Set it via PATCH /api/users/:id  { fingerprint_id: "5" }
 */

const Attendance = require("../models/attendance");
const User = require("../models/users");

// ─── Shared Helpers ──────────────────────────────────────────────────────────

const toMidnight = (date = new Date()) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const calcHours = (clockIn, clockOut) =>
  Math.round(((clockOut - clockIn) / (1000 * 60 * 60)) * 100) / 100;

const deriveStatus = (clockIn, clockOut = null) => {
  const totalMinutes =
    new Date(clockIn).getHours() * 60 + new Date(clockIn).getMinutes();
  if (clockOut) {
    const worked = calcHours(new Date(clockIn), new Date(clockOut));
    if (worked < 4) return "half-day";
  }
  if (totalMinutes > 9 * 60 + 15) return "late";
  return "present";
};

/**
 * Decode eSSL punch type code → human-readable string.
 * eSSL device sends a numeric type:
 *   0 = check-in, 1 = check-out, 2 = break-out, 3 = break-in, 4 = OT-in, 5 = OT-out
 */
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

/**
 * Decode eSSL verify method code → human-readable string.
 *   1 = fingerprint, 3 = password, 11 = face, 15 = card
 */
const decodeVerifyMethod = (verifyCode) => {
  const map = { "1": "fingerprint", "3": "password", "11": "face", "15": "card" };
  return map[String(verifyCode)] || "fingerprint";
};

/**
 * Core function: given a set of raw punch events for one employee on one day,
 * upsert the Attendance document.
 *
 * Logic:
 *  - First check-in type punch  → clock_in
 *  - Last  check-out type punch → clock_out
 */
const upsertAttendanceFromPunches = async (userId, dateObj, punches, deviceSerial) => {
  const date = toMidnight(dateObj);

  // Sort punches chronologically
  punches.sort((a, b) => new Date(a.time) - new Date(b.time));

  // Find first clock-in and last clock-out
  const clockInPunch = punches.find((p) =>
    ["check-in", "overtime-in"].includes(p.type)
  );
  const clockOutPunch = [...punches]
    .reverse()
    .find((p) => ["check-out", "overtime-out"].includes(p.type));

  if (!clockInPunch) return null; // no valid clock-in, skip

  const clock_in = new Date(clockInPunch.time);
  const clock_out = clockOutPunch ? new Date(clockOutPunch.time) : null;
  const hours_worked = clock_out ? calcHours(clock_in, clock_out) : null;
  const status = deriveStatus(clock_in, clock_out);

  // Build raw_logs array from all punches (coerce to strings to match schema).
  const raw_logs = punches.map((p) => ({
    time: new Date(p.time),
    type: String(p.type),
    verify: String(p.verify),
  }));

  const record = await Attendance.findOneAndUpdate(
    { user_id: userId, date },
    {
      $set: {
        clock_in,
        clock_out,
        hours_worked,
        status,
        source: "fingerprint",
        device_serial: deviceSerial || null,
      },
      // $push (not $addToSet) — raw_logs is an array of subdocuments; $push
      // appends the new punch events for this day.
      $push: {
        raw_logs: { $each: raw_logs },
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true }
  );

  return record;
};

// ─── METHOD 1: ADMS PUSH RECEIVER ────────────────────────────────────────────

const admsHandshake = async (req, res) => {
  try {
    const { SN } = req.query;
    console.log(`[eSSL] ✅ Device handshake — Serial: ${SN} | IP: ${req.ip} | Query: ${JSON.stringify(req.query)}`);

    // Respond with current server time so device syncs its clock
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

    // FIX: TimeZone=5.5 = IST (UTC+5:30). TransTimes pushes at midnight and every 30 min.
    // Realtime=1 means device also pushes each punch immediately as it happens.
    res.set("Content-Type", "text/plain");
    res.send(`GET OPTION FROM: ${SN}\nATTSTAMP\nErrorDelay=30\nDelay=10\nTransTimes=00:00;00:30;01:00;01:30;02:00;02:30;03:00;03:30;04:00;04:30;05:00;05:30;06:00;06:30;07:00;07:30;08:00;08:30;09:00;09:30;10:00;10:30;11:00;11:30;12:00;12:30;13:00;13:30;14:00;14:30;15:00;15:30;16:00;16:30;17:00;17:30;18:00;18:30;19:00;19:30;20:00;20:30;21:00;21:30;22:00;22:30;23:00;23:30\nTransInterval=1\nTransFlag=TransData AttLog OpLog EnrollUser\nTimeZone=5.5\nRealtime=1\nEncrypt=0\nServerVer=2.4\nTableNameFix=0\nDate=${timestamp}\n`);
  } catch (err) {
    console.error("[eSSL] Handshake error:", err);
    res.status(500).send("ERROR");
  }
};

/**
 * GET /api/essl/getrequest
 * Device polls this endpoint waiting for commands from server.
 * Respond with "OK" when no commands are queued.
 */
const getRequest = (req, res) => {
  res.set("Content-Type", "text/plain");
  res.send("OK");
};

/**
 * POST /api/essl/adms
 * Main endpoint — device pushes attendance logs here.
 *
 * Query: ?SN=SERIAL&table=ATTLOG&Stamp=XXXXX
 * Body (plain text, one line per punch):
 *   fingerprint_id\tYYYY-MM-DD HH:MM:SS\tpunch_type\tverify_method\t0\t0
 */
const admsReceiver = async (req, res) => {
  try {
    const { SN: deviceSerial, table } = req.query;

    // The body comes as plain text from the device.
    const rawBody =
      typeof req.body === "string" ? req.body : req.body?.toString?.() || "";

    console.log(`[eSSL] 📥 POST /iclock/cdata — Device: ${deviceSerial} | Table: ${table} | Body length: ${rawBody.length}`);

    // Only process attendance logs; ignore other tables (EnrollUser, OpLog, etc.)
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

    // Parse each line: fingerprint_id \t datetime \t punch_type \t verify \t ...
    const lines = rawBody.trim().split("\n").filter(Boolean);
    const punchMap = new Map(); // key: "fingerprint_id::YYYY-MM-DD" → [punches]

    for (const line of lines) {
      const parts = line.trim().split(/\t|\s{2,}/); // tab or double-space separated
      if (parts.length < 2) continue;

      const [fingerprintId, datetimeStr, typeCode = "0", verifyCode = "1"] = parts;
      const punchTime = new Date(datetimeStr.trim().replace(" ", "T") + "+05:30");
      if (isNaN(punchTime)) continue;

      const dateKey = punchTime.toISOString().slice(0, 10); // "YYYY-MM-DD"
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

    // Get all unique fingerprint IDs from the batch
    const fingerprintIds = [...new Set([...punchMap.keys()].map((k) => k.split("::")[0]))];

    // Lookup users by fingerprint_id
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
        await upsertAttendanceFromPunches(user._id, new Date(dateStr), punches, deviceSerial);
        results.saved++;
        console.log(`[eSSL] Saved attendance for ${user.name} (fp:${fpId}) on ${dateStr}`);
      } catch (err) {
        results.errors.push({ fpId, dateStr, error: err.message });
        console.error(`[eSSL] Error saving for fp:${fpId} on ${dateStr}:`, err.message);
      }
    }

    console.log(`[eSSL] Batch complete — saved:${results.saved} skipped:${results.skipped} errors:${results.errors.length}`);

    // Device expects plain "OK" on success
    res.set("Content-Type", "text/plain");
    res.send("OK");
  } catch (err) {
    console.error("[eSSL] Fatal ADMS receiver error:", err);
    res.set("Content-Type", "text/plain");
    res.send("ERROR");
  }
};

// ─── METHOD 2: TCP PULL SYNC ─────────────────────────────────────────────────

/**
 * POST /api/essl/sync
 * Admin manually triggers a pull from the device via TCP.
 * Body: { ip: "192.168.1.100", port: 4370, device_serial: "optional" }
 *
 * Requires: npm install node-zklib
 */
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

    // Pull all attendance records from device
    const { data: logs } = await zkInstance.getAttendances();

    if (!logs || logs.length === 0) {
      await zkInstance.disconnect();
      return res.status(200).json({ success: true, message: "No logs found on device", saved: 0 });
    }

    console.log(`[eSSL] Pulled ${logs.length} punch records from device`);

    // Group punches by fingerprint_id + date
    const punchMap = new Map();

    for (const log of logs) {
      // node-zklib returns: { deviceUserId, userSn, recordTime, type, inOutStatus }
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

    // Lookup users
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
        await upsertAttendanceFromPunches(user._id, new Date(dateStr), punches, device_serial || ip);
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

/**
 * PATCH /api/essl/assign-fingerprint
 * Admin maps a fingerprint_id (from the device) to a user.
 * Body: { user_id: "...", fingerprint_id: "5" }
 */
const assignFingerprintId = async (req, res) => {
  try {
    const { user_id, fingerprint_id } = req.body;

    if (!user_id || !fingerprint_id) {
      return res.status(400).json({ success: false, message: "user_id and fingerprint_id are required" });
    }

    // Check for duplicate fingerprint_id
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

/**
 * GET /api/essl/fingerprint-map
 * Admin — list all employees with their fingerprint IDs.
 */
const getFingerprintMap = async (req, res) => {
  try {
    const users = await User.find({}, "name email department designation fingerprint_id status");

    return res.status(200).json({ success: true, data: users });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  admsHandshake,
  getRequest,
  admsReceiver,
  syncFromDevice,
  assignFingerprintId,
  getFingerprintMap,
};
