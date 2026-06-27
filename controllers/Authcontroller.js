const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/users");

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({ success: false, message: error.message || "Internal server error" });
};

// ─── REGISTER ────────────────────────────────────────────────────────────────

const register = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!password) {
      return res.status(400).json({ success: false, message: "Password is required" });
    }

    const existing = await User.findOne({ email: email?.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: "Email is already registered" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Persist every field the admin form provides (personal, banking, statutory,
    // health, emergency, employment, etc.), minus protected/computed keys.
    // Mongoose's strict mode drops anything not defined on the schema, so this
    // can't inject arbitrary fields.
    const payload = { ...req.body };
    ['password', '_id', '__v', 'createdAt', 'updatedAt', 'designationHistory'].forEach(
      (k) => delete payload[k]
    );
    // Treat empty strings as "not provided" so schema defaults/nulls apply and
    // Date/Number fields (e.g. dateOfBirth, joining_date) don't fail casting.
    Object.keys(payload).forEach((k) => { if (payload[k] === '') delete payload[k]; });

    const user = await User.create({ ...payload, password: hashedPassword });

    // Return user without password
    const userObj = user.toObject();
    delete userObj.password;

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: userObj,
      token: generateToken(user._id),
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return handleError(res, error);
  }
};

// ─── LOGIN ───────────────────────────────────────────────────────────────────

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    // Explicitly select password since it's `select: false` in schema
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+password");

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    if (user.status === "inactive") {
      return res.status(403).json({ success: false, message: "Account is deactivated. Contact admin." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const userObj = user.toObject();
    delete userObj.password;

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: userObj,
      token: generateToken(user._id),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET ME ──────────────────────────────────────────────────────────────────

const getMe = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: req.user });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── CHANGE PASSWORD ─────────────────────────────────────────────────────────

const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: "Both current and new password are required" });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters" });
    }

    const user = await User.findById(req.user._id).select("+password");

    const isMatch = await bcrypt.compare(current_password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(new_password, salt);
    await user.save();

    return res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = { register, login, getMe, changePassword };