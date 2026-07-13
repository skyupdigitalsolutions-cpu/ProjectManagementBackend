const express = require("express");
const router = express.Router();

const {
  submitReport,
  getMyReports,
  getTodayReport,
  getAllReports,
  getUserReports,
  deleteReport,
} = require("../controllers/Dailyreportcontroller");

const { protect, authorise } = require("../middleware/authMiddleware");
const { buildDailyReportDigest, sendDailyReportDigest } = require("../services/dailyReportDigest");


router.post("/", protect, submitReport);


router.get("/today", protect, getTodayReport);


router.get("/my", protect, getMyReports);


router.get("/user/:user_id", protect, authorise("admin", "manager"), getUserReports);


router.get("/", protect, authorise("admin", "manager"), getAllReports);


router.delete("/:id", protect, deleteReport);

// ─── GET /api/daily-reports/digest/preview?date=YYYY-MM-DD ─────────────────────
// Returns the exact Telegram text (no message sent).
router.get("/digest/preview", protect, authorise("admin", "manager"), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: "Invalid date" });
    const { text, counts } = await buildDailyReportDigest(date);
    return res.json({ success: true, counts, text });
  } catch (err) {
    console.error("Daily report digest preview error:", err);
    return res.status(500).json({ success: false, message: "Preview failed" });
  }
});

// ─── POST /api/daily-reports/digest/send?date=YYYY-MM-DD ───────────────────────
// Builds the daily-report digest and broadcasts it to every chat in
// TELEGRAM_DAILY_REPORT_CHAT_IDS.
router.post("/digest/send", protect, authorise("admin"), async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ success: false, message: "Invalid date" });
    const result = await sendDailyReportDigest(date);
    const code = result.ok ? 200 : (result.skipped ? 400 : 502);
    return res.status(code).json({ success: result.ok, ...result });
  } catch (err) {
    console.error("Daily report digest send error:", err);
    return res.status(500).json({ success: false, message: "Send failed" });
  }
});

module.exports = router;