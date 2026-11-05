/**
 * routes/attendanceAppRoutes.js — read-only endpoints for the Attendance Admin PWA.
 * Admins only. Mounted in routes/Index.js as: router.use("/attendance-app", attendanceAppRoutes)
 */
const express = require("express");
const router = express.Router();
const c = require("../controllers/attendanceAppController");
const { protect, authorise } = require("../middleware/authMiddleware");

router.use(protect, authorise("admin"));

router.get("/users",         c.listUsers);        // people list
router.get("/day",           c.getDay);           // everyone on one day
router.get("/user/:id",      c.getUserTimeline);  // one employee, day by day
router.get("/register",      c.getRegister);      // monthly register
router.get("/leave-balance", c.getLeaveBalance);  // ?user_id=&year=
router.patch("/user/:id/ids", c.setUserIds);      // set Employee ID / Device ID
router.put("/record",        c.saveDayRecord);    // mark a day: WFH, status, times, remark

module.exports = router;
