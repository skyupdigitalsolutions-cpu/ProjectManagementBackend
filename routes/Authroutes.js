const express = require("express");
const router = express.Router();

const { register, login, getMe, changePassword } = require("../controllers/Authcontroller");
const { protect, authorise } = require("../middleware/authMiddleware");



router.post("/register",         protect, authorise("admin"), register);
router.post("/login",            login);

// Forgot password (emailed 6-digit code). Rate-limited per IP.
const rateLimit = require("express-rate-limit");
const { forgotPassword, resetPassword } = require("../controllers/passwordResetController");
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Wait 15 minutes and try again." } });
router.post("/forgot-password", resetLimiter, forgotPassword);
router.post("/reset-password",  resetLimiter, resetPassword);
router.get("/me",                protect, getMe);
router.patch("/change-password", protect, changePassword);

module.exports = router;
