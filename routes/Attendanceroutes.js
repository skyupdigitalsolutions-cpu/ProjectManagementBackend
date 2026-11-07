/**
 * routes/Attendanceroutes.js
 * Classic attendance routes (clock-in, breaks, Telegram digest, admin views).
 *
 * Safe on startup: a route is registered only if its handler is exported by
 * controllers/Attendancecontroller.js. A missing handler logs a warning instead
 * of crashing the whole server ("argument handler must be a function").
 * Once the original controller is restored, every route registers automatically.
 */
const express = require("express");
const router = express.Router();

const controller = require("../controllers/Attendancecontroller");
const { protect, authorise } = require("../middleware/authMiddleware");

const admin = authorise("admin");
const adminManager = authorise("admin", "manager");

function add(method, path, handlerName, ...middleware) {
  const handler = controller[handlerName];
  if (typeof handler !== "function") {
    console.warn(`[attendance routes] skipped ${method.toUpperCase()} ${path}: "${handlerName}" is not exported by controllers/Attendancecontroller.js`);
    return;
  }
  router[method](path, protect, ...middleware, handler);
}

add("post",  "/clock-in",        "clockIn");
add("patch", "/clock-out",       "clockOut");
add("post",  "/break/start",     "startBreak");
add("patch", "/break/end",       "endBreak");
add("get",   "/today",           "getTodayStatus");
add("get",   "/my",              "getMyAttendance");
add("post",  "/mark-absent",     "markAbsent",       adminManager);
add("post",  "/telegram/test",   "testTelegram",     admin);
add("post",  "/telegram/digest", "sendDigestNow",    admin);
add("get",   "/summary/:user_id","getMonthlySummary");
add("get",   "/user/:user_id",   "getUserAttendance",adminManager);
add("get",   "/",                "getAllAttendance", adminManager);
add("patch", "/:id",             "updateAttendanceRecord", admin);

module.exports = router;
