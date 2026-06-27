const express = require("express");
const router = express.Router();

const {
  clockIn,
  clockOut,
  startBreak,
  endBreak,
  getTodayStatus,
  getMyAttendance,
  getUserAttendance,
  getAllAttendance,
  updateAttendanceRecord,
  markAbsent,
  getMonthlySummary,
} = require("../controllers/Attendancecontroller");
const { protect, authorise } = require("../middleware/authMiddleware");


router.post("/clock-in",              protect, clockIn);
router.patch("/clock-out",            protect, clockOut);
router.post("/break/start",           protect, startBreak);
router.patch("/break/end",            protect, endBreak);
router.get("/today",                  protect, getTodayStatus);
router.get("/my",                     protect, getMyAttendance);
router.post("/mark-absent",           protect, authorise("admin", "manager"), markAbsent);
router.get("/summary/:user_id",       protect, getMonthlySummary);
router.get("/user/:user_id",          protect, authorise("admin", "manager"), getUserAttendance);
router.get("/",                       protect, authorise("admin", "manager"), getAllAttendance);
router.patch("/:id",                  protect, authorise("admin"), updateAttendanceRecord);

module.exports = router;