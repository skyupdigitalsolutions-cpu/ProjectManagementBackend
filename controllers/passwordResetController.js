/**
 * controllers/passwordResetController.js — "Forgot password" with an emailed code.
 *
 *   POST /api/auth/forgot-password  { email }
 *     Always answers the same way (doesn't reveal whether the email exists).
 *     If it belongs to an active account, emails a 6-digit code valid 15 min.
 *   POST /api/auth/reset-password   { email, code, password }
 *     Checks the code (5 tries max), sets the new password, clears the code.
 *
 * Email goes through Brevo, like the rest of the backend:
 *   BREVO_API_KEY, and the sender address from BREVO_FROM_EMAIL or EMAIL_USER
 *   (the same sender the existing email feature uses). Name: BREVO_FROM_NAME / EMAIL_FROM_NAME.
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Brevo = require("@getbrevo/brevo");
const User = require("../models/users");

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD = 8;
const GENERIC = "If that email belongs to an account, a 6-digit code is on its way. It's valid for 15 minutes.";

const hashCode = (userId, code) =>
  crypto.createHash("sha256").update(`${userId}:${code}:${process.env.JWT_SECRET || ""}`).digest("hex");

const senderEmail = () => process.env.BREVO_FROM_EMAIL || process.env.EMAIL_USER || "";
const senderName = () => process.env.BREVO_FROM_NAME || process.env.EMAIL_FROM_NAME || "SkyUp CRM";

async function sendCodeEmail(user, code) {
  if (!process.env.BREVO_API_KEY || !senderEmail()) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[password-reset] Brevo not configured. Code for ${user.email}: ${code}`);
      return;
    }
    throw new Error("BREVO_API_KEY or the sender address (BREVO_FROM_EMAIL / EMAIL_USER) is not set");
  }
  const api = new Brevo.TransactionalEmailsApi();
  api.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
  const mail = new Brevo.SendSmtpEmail();
  mail.sender = { name: senderName(), email: senderEmail() };
  mail.to = [{ email: user.email, name: user.name }];
  mail.subject = `${code} is your password reset code`;
  mail.htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#111827">
      <h2 style="margin:0 0 12px">Reset your password</h2>
      <p>Hi ${String(user.name || "").replace(/[<>&]/g, "")},</p>
      <p>Use this code to set a new password. It's valid for 15 minutes.</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0">${code}</p>
      <p style="color:#6b7280;font-size:13px">If you didn't ask for this, you can ignore this email. Your password stays the same.</p>
    </div>`;
  mail.textContent = `Your password reset code is ${code}. It's valid for 15 minutes. If you didn't ask for this, ignore this email.`;
  await api.sendTransacEmail(mail);
}

// POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: "Enter your email" });
    const user = await User.findOne({ email }).select("+reset_code_sent_at");
    if (user && user.status !== "inactive") {
      const recently = user.reset_code_sent_at && Date.now() - user.reset_code_sent_at < RESEND_AFTER_MS;
      if (!recently) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        await User.updateOne({ _id: user._id }, { $set: {
          reset_code_hash: hashCode(user._id, code), reset_code_expires: new Date(Date.now() + CODE_TTL_MS),
          reset_code_attempts: 0, reset_code_sent_at: new Date(),
        } });
        await sendCodeEmail(user, code);
      }
    }
    return res.json({ success: true, message: GENERIC });
  } catch (err) {
    console.error("[password-reset] forgot failed:", err.message);
    return res.status(500).json({ success: false, message: "Couldn't send the code right now. Try again in a few minutes." });
  }
};

// POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").replace(/\D/g, "");
    const password = String(req.body?.password || "");
    if (!email || code.length !== 6) return res.status(400).json({ success: false, message: "Enter your email and the 6-digit code" });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ success: false, message: `The new password must be at least ${MIN_PASSWORD} characters` });

    const bad = { success: false, message: "That code is wrong or has expired. Request a new one." };
    const user = await User.findOne({ email }).select("+reset_code_hash +reset_code_expires +reset_code_attempts");
    if (!user || !user.reset_code_hash || !user.reset_code_expires || user.reset_code_expires < new Date()) return res.status(400).json(bad);
    if ((user.reset_code_attempts || 0) >= MAX_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many wrong codes. Request a new code." });
    }
    const a = Buffer.from(hashCode(user._id, code)), b = Buffer.from(user.reset_code_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await User.updateOne({ _id: user._id }, { $inc: { reset_code_attempts: 1 } });
      return res.status(400).json(bad);
    }
    const hash = await bcrypt.hash(password, await bcrypt.genSalt(10));
    await User.updateOne({ _id: user._id }, {
      $set: { password: hash },
      $unset: { reset_code_hash: "", reset_code_expires: "", reset_code_attempts: "", reset_code_sent_at: "" },
    });
    return res.json({ success: true, message: "Password changed. You can sign in with your new password." });
  } catch (err) {
    console.error("[password-reset] reset failed:", err.message);
    return res.status(500).json({ success: false, message: "Couldn't change the password right now. Try again." });
  }
};

module.exports = { forgotPassword, resetPassword };
