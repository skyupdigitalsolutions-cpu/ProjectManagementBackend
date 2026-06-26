/**
 * EsslController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles all eSSL / ZKTeco fingerprint machine integration.
 *
 * eSSL F22 NOTE: this device sends EVERY punch as type "check-in" (it does not
 * distinguish in vs out). So clock_in/clock_out are derived by ORDER, not type:
 *   first punch of the day = clock_in, last punch = clock_out.
 *
 * HOW fingerprint_id MAPS TO employees:
 *   Each employee must have their fingerprint_id set in the User document.
 *   Set it via PATCH /api/essl/assign-fingerprint  { user_id, fingerprint_id }
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

/**
 * Core function: given new punch events for one employee on one day, merge them
 * with any punches already stored for that day, de-duplicate, and recompute
 * clock_in / clock_out.
 *
 * The eSSL F22 sends every punch as "check-in", so we DON'T trust the type.
 * Instead we order all punches by time:
 *   first punch  → clock_in
 *   last  punch  → clock_out   (2nd/4th/… punches are outs; last one wins)
 * A single punch = clocked in but not out yet (clock_out stays null).
 */
const upsertAttendanceFromPunches = async (userId, dateObj, punches, deviceSerial) => {
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

  // 5. Derive clock_in / clock_out by ORDER (first = in, last = out).
  const clock_in = new Date(allPunches[0].time);
  const clock_out =
    allPunches.length > 1 ? new Date(allPunches[allPunches.length - 1].time) : null;

  const hours_worked = clock_out ? calcHours(clock_in, clock_out) : null;
  const status = deriveStatus(clock_in, clock_out);

  // 6. Save the full deduped set with $set (NOT $push — avoids duplicate pile-up).
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
        raw_logs: allPunches,
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
        await upsertAttendanceFromPunches(user._id, new Date(dateStr), punches, deviceSerial);
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

module.exports = {
  admsHandshake,
  getRequest,
  admsReceiver,
  syncFromDevice,
  assignFingerprintId,
  getFingerprintMap,
};