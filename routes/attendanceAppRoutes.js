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
router.get("/ids",           c.listIds);          // everyone's IDs + unassigned machine IDs
router.put("/ids",           c.saveIds);          // save many IDs at once (swaps allowed)
router.delete("/ids/unassigned/:deviceId", c.discardUnassigned);
router.put("/record",        c.saveDayRecord);    // mark a day: WFH, status, times, remark
router.get("/data-health",   c.getDataHealth);    // split days, wrong dates, uncorrected punches
router.post("/repair",       c.repairData);       // preview / apply the data repair
router.post("/repair/undo",  c.undoRepair);       // restore from a repair backup

module.exports = router;
