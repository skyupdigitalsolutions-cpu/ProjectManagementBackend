/**
 * controllers/policyController.js
 *
 * Endpoints:
 *   GET    /api/policy           — get active policy (all authenticated users)
 *   GET    /api/policy/all       — get all policy versions (admin)
 *   POST   /api/policy           — create new policy / replace active (admin)
 *   PATCH  /api/policy/:id       — update a policy (admin)
 *   POST   /api/policy/holidays  — add a holiday (admin)
 *   DELETE /api/policy/holidays/:date — remove a holiday (admin)
 */

const Policy = require('../models/policy');

// ─────────────────────────────────────────────────────────────────────────────
//  getActivePolicy
//  GET /api/policy
// ─────────────────────────────────────────────────────────────────────────────

const getActivePolicy = async (req, res) => {
  try {
    let policy = await Policy.findOne({ is_active: true })
      .sort({ createdAt: -1 })
      .populate('created_by', 'name');

    // Auto-create a default policy if none exists
    if (!policy) {
      policy = await Policy.create({ is_active: true });
    }

    return res.status(200).json({ success: true, data: policy });
  } catch (err) {
    console.error('[Policy] getActivePolicy error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  getAllPolicies
//  GET /api/policy/all
// ─────────────────────────────────────────────────────────────────────────────

const getAllPolicies = async (req, res) => {
  try {
    const policies = await Policy.find()
      .sort({ createdAt: -1 })
      .populate('created_by', 'name');

    return res.status(200).json({
      success: true,
      total:   policies.length,
      data:    policies,
    });
  } catch (err) {
    console.error('[Policy] getAllPolicies error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  createPolicy
//  POST /api/policy
//  Creates a new policy and sets it as active (deactivates the old one)
// ─────────────────────────────────────────────────────────────────────────────

const createPolicy = async (req, res) => {
  try {
    // Accept every policy field the form sends (Mongoose strict mode drops
    // anything not on the schema), minus computed/protected keys.
    const payload = { ...req.body };
    ['_id', '__v', 'createdAt', 'updatedAt', 'created_by'].forEach((k) => delete payload[k]);

    // Deactivate all existing policies
    await Policy.updateMany({}, { $set: { is_active: false } });

    const policy = await Policy.create({
      ...payload,
      holidays:   payload.holidays ?? [],
      is_active:  true,
      created_by: req.user._id,
    });

    return res.status(201).json({
      success: true,
      message: 'Policy created and set as active',
      data:    policy,
    });
  } catch (err) {
    console.error('[Policy] createPolicy error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  updatePolicy
//  PATCH /api/policy/:id
// ─────────────────────────────────────────────────────────────────────────────

const updatePolicy = async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent updating holidays via this endpoint (use dedicated endpoints below)
    const { holidays, ...rest } = req.body;

    const policy = await Policy.findByIdAndUpdate(
      id,
      { $set: rest },
      { new: true, runValidators: true }
    );

    if (!policy) {
      return res.status(404).json({ success: false, message: 'Policy not found' });
    }

    return res.status(200).json({
      success: true,
      message: 'Policy updated',
      data:    policy,
    });
  } catch (err) {
    console.error('[Policy] updatePolicy error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  addHoliday
//  POST /api/policy/holidays
//  Body: { date, name, description? }
//  Adds to the currently active policy
// ─────────────────────────────────────────────────────────────────────────────

const addHoliday = async (req, res) => {
  try {
    const { date, name, description, is_optional } = req.body;

    if (!date || !name) {
      return res.status(400).json({ success: false, message: 'date and name are required' });
    }

    const holidayDate = new Date(date);
    if (isNaN(holidayDate)) {
      return res.status(400).json({ success: false, message: 'Invalid date format' });
    }

    const policy = await Policy.findOne({ is_active: true });
    if (!policy) {
      return res.status(404).json({ success: false, message: 'No active policy found' });
    }

    // Prevent duplicate dates
    const duplicate = policy.holidays.some(
      h => new Date(h.date).toDateString() === holidayDate.toDateString()
    );
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'A holiday already exists on this date' });
    }

    policy.holidays.push({ date: holidayDate, name: name.trim(), description: description?.trim() || null, is_optional: !!is_optional });
    policy.holidays.sort((a, b) => new Date(a.date) - new Date(b.date));
    await policy.save();

    return res.status(201).json({
      success: true,
      message: `Holiday "${name}" added`,
      data:    policy,
    });
  } catch (err) {
    console.error('[Policy] addHoliday error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  removeHoliday
//  DELETE /api/policy/holidays/:date
//  :date in format YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────

const removeHoliday = async (req, res) => {
  try {
    const targetDate = new Date(req.params.date);
    if (isNaN(targetDate)) {
      return res.status(400).json({ success: false, message: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const policy = await Policy.findOne({ is_active: true });
    if (!policy) {
      return res.status(404).json({ success: false, message: 'No active policy found' });
    }

    const before = policy.holidays.length;
    policy.holidays = policy.holidays.filter(
      h => new Date(h.date).toDateString() !== targetDate.toDateString()
    );

    if (policy.holidays.length === before) {
      return res.status(404).json({ success: false, message: 'No holiday found on this date' });
    }

    await policy.save();

    return res.status(200).json({
      success: true,
      message: 'Holiday removed',
      data:    policy,
    });
  } catch (err) {
    console.error('[Policy] removeHoliday error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getActivePolicy,
  getAllPolicies,
  createPolicy,
  updatePolicy,
  addHoliday,
  removeHoliday,
};