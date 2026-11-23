const express = require("express");
const router = express.Router();

const { register, login, getMe, changePassword } = require("../controllers/Authcontroller");
const { protect, authorise } = require("../middleware/authMiddleware");



router.post("/register",         protect, authorise("admin"), register);
// Login is rate-limited per IP and email: at most 15 failed attempts in 15 minutes, so passwords
// cannot be guessed endlessly. Successful logins do not count.
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || "").toLowerCase().trim()}`,
  message: { success: false, message: "Too many failed attempts. Wait 15 minutes and try again." },
});
router.post("/login",            loginLimiter, login);

// Forgot password (emailed 6-digit code). Rate-limited per IP.
const { forgotPassword, resetPassword } = require("../controllers/passwordResetController");
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Wait 15 minutes and try again." } });
router.post("/forgot-password", resetLimiter, forgotPassword);
router.post("/reset-password",  resetLimiter, resetPassword);
router.get("/me",                protect, getMe);
router.patch("/change-password", protect, changePassword);

module.exports = router;