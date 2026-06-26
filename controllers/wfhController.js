/**
 * controllers/wfhController.js
 *
 * Endpoints:
 *   POST   /api/wfh/request                  — employee submits WFH request
 *   GET    /api/wfh/my-requests              — employee views own requests
 *   GET    /api/wfh/requests?status=pending  — admin/manager views all requests
 *   PATCH  /api/wfh/request/:id/status       — admin approves / rejects
 *   PATCH  /api/wfh/override/:user_id        — admin sets work_mode + attendance_override
 */

const WfhRequest = require('../models/WfhRequest');
const User       = require('../models/users');

// ─────────────────────────────────────────────────────────────────────────────
//  submitWfhRequest
//  POST /api/wfh/request
//  Body: { from_date, to_date, reason }
// ─────────────────────────────────────────────────────────────────────────────

const submitWfhRequest = async (req, res) => {
  try {
    const { from_date, to_date, reason } = req.body;

    if (!from_date || !to_date || !reason) {
      return res.status(400).json({
        success: false,
        message: 'from_date, to_date, and reason are required',
      });
    }

    const from = new Date(from_date);
    const to   = new Date(to_date);

    if (isNaN(from) || isNaN(to)) {
      return res.status(400).json({ success: false, message: 'Invalid date format' });
    }
    if (to < from) {
      return res.status(400).json({ success: false, message: 'to_date must be on or after from_date' });
    }
    if (reason.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Reason must be at least 5 characters' });
    }

    const request = await WfhRequest.create({
      user_id:   req.user._id,
      from_date: from,
      to_date:   to,
      reason:    reason.trim(),
    });

    return res.status(201).json({
      success: true,
      message: 'WFH request submitted successfully',
      data:    request,
    });
  } catch (err) {
    console.error('[WFH] submitWfhRequest error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  getMyWfhRequests
//  GET /api/wfh/my-requests?limit=10&page=1
// ─────────────────────────────────────────────────────────────────────────────

const getMyWfhRequests = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const page  = Math.max(parseInt(req.query.page)  || 1,  1);
    const skip  = (page - 1) * limit;

    const [requests, total] = await Promise.all([
      WfhRequest.find({ user_id: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('reviewed_by', 'name'),
      WfhRequest.countDocuments({ user_id: req.user._id }),
    ]);

    return res.status(200).json({
      success: true,
      data:    requests,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[WFH] getMyWfhRequests error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  getAllWfhRequests
//  GET /api/wfh/requests?status=pending&page=1&limit=20
//  Admin / manager view
// ─────────────────────────────────────────────────────────────────────────────

const getAllWfhRequests = async (req, res) => {
  try {
    const { status, page: p, limit: l } = req.query;
    const limit = Math.min(parseInt(l) || 20, 100);
    const page  = Math.max(parseInt(p) || 1,  1);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      filter.status = status;
    }

    const [requests, total] = await Promise.all([
      WfhRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user_id',     'name email department designation work_mode attendance_override')
        .populate('reviewed_by', 'name'),
      WfhRequest.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data:    requests,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[WFH] getAllWfhRequests error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  updateWfhRequestStatus
//  PATCH /api/wfh/request/:id/status
//  Body: { status: 'approved'|'rejected', admin_note? }
// ─────────────────────────────────────────────────────────────────────────────

const updateWfhRequestStatus = async (req, res) => {
  try {
    const { id }                   = req.params;
    const { status, admin_note }   = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be 'approved' or 'rejected'",
      });
    }

    const request = await WfhRequest.findById(id).populate('user_id', 'name email');
    if (!request) {
      return res.status(404).json({ success: false, message: 'WFH request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: `Request has already been ${request.status}`,
      });
    }

    request.status      = status;
    request.admin_note  = admin_note?.trim() || null;
    request.reviewed_by = req.user._id;
    request.reviewed_at = new Date();
    await request.save();

    console.log(
      `[WFH] Request ${id} ${status} by ${req.user.name} for user ${request.user_id?.name}`
    );

    return res.status(200).json({
      success: true,
      message: `WFH request ${status}`,
      data:    request,
    });
  } catch (err) {
    console.error('[WFH] updateWfhRequestStatus error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  setUserWorkModeOverride
//  PATCH /api/wfh/override/:user_id
//  Body: { work_mode: 'office'|'wfh'|'hybrid', attendance_override: boolean }
//  Admin only — directly sets a user's work mode and biometric override flag
// ─────────────────────────────────────────────────────────────────────────────

const setUserWorkModeOverride = async (req, res) => {
  try {
    const { user_id }                       = req.params;
    const { work_mode, attendance_override } = req.body;

    if (work_mode && !['office', 'wfh', 'hybrid'].includes(work_mode)) {
      return res.status(400).json({
        success: false,
        message: "work_mode must be 'office', 'wfh', or 'hybrid'",
      });
    }

    const updates = {};
    if (work_mode           !== undefined) updates.work_mode           = work_mode;
    if (attendance_override !== undefined) updates.attendance_override = Boolean(attendance_override);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least work_mode or attendance_override to update',
      });
    }

    const user = await User.findByIdAndUpdate(
      user_id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('name email department work_mode attendance_override');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    console.log(
      `[WFH] Override updated for ${user.name}: work_mode=${user.work_mode} override=${user.attendance_override}`
    );

    return res.status(200).json({
      success: true,
      message: `Work mode updated for ${user.name}`,
      data:    user,
    });
  } catch (err) {
    console.error('[WFH] setUserWorkModeOverride error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  submitWfhRequest,
  getMyWfhRequests,
  getAllWfhRequests,
  updateWfhRequestStatus,
  setUserWorkModeOverride,
};