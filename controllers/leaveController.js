const mongoose  = require("mongoose");
const Leave     = require("../models/leave");
const User      = require("../models/users");
const Notification = require("../models/notification");
const { handleLeaveReassignment } = require("../services/autoAssignService");

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({
    success: false,
    message: error.message || "Internal server error",
  });
};

// ─── APPLY FOR LEAVE ─────────────────────────────────────────────────────────

const applyLeave = async (req, res) => {
  try {
    const {
      leave_type, from_date, to_date, days, reason,
      is_urgent, contact_during_leave, handover_notes,
    } = req.body;

    if (!leave_type || !from_date || !to_date || !days || !reason)
      return res.status(400).json({
        success: false,
        message: "leave_type, from_date, to_date, days, and reason are required",
      });

    const from = new Date(from_date);
    const to   = new Date(to_date);

    if (isNaN(from) || isNaN(to))
      return res.status(400).json({ success: false, message: "Invalid date format" });
    if (to < from)
      return res.status(400).json({ success: false, message: "to_date must be on or after from_date" });
    if (reason.trim().length < 20)
      return res.status(400).json({ success: false, message: "Reason must be at least 20 characters" });

    const overlap = await Leave.findOne({
      user_id:   req.user._id,
      status:    { $ne: "rejected" },
      from_date: { $lte: to },
      to_date:   { $gte: from },
    });

    if (overlap)
      return res.status(409).json({
        success: false,
        message: "You already have a leave request overlapping these dates",
      });

    const leave = await Leave.create({
      user_id: req.user._id,
      leave_type,
      from_date: from,
      to_date:   to,
      days,
      reason:   reason.trim(),
      is_urgent: !!is_urgent,
      contact_during_leave: contact_during_leave || null,
      handover_notes:       handover_notes || null,
    });

    return res.status(201).json({ success: true, data: leave });
  } catch (error) {
    if (error.name === "ValidationError")
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── MY LEAVES ───────────────────────────────────────────────────────────────

const getMyLeaves = async (req, res) => {
  try {
    const leaves = await Leave.find({ user_id: req.user._id })
      .sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: leaves });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── ALL LEAVES (admin/manager) ──────────────────────────────────────────────

const getAllLeaves = async (req, res) => {
  try {
    const { status, user_id, from_date, to_date } = req.query;
    const filter = {};
    if (status)  filter.status = status;
    if (user_id) {
      if (!isValidObjectId(user_id))
        return res.status(400).json({ success: false, message: "Invalid user_id" });
      filter.user_id = user_id;
    }
    if (from_date) filter.from_date = { $gte: new Date(from_date) };
    if (to_date)   filter.to_date   = { ...(filter.to_date || {}), $lte: new Date(to_date) };

    const leaves = await Leave.find(filter)
      .populate("user_id",      "name email department designation")
      .populate("reviewed_by",  "name email")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, data: leaves });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET BY ID ───────────────────────────────────────────────────────────────

const getLeaveById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid leave ID" });

    const leave = await Leave.findById(id)
      .populate("user_id",     "name email department designation")
      .populate("reviewed_by", "name email");

    if (!leave)
      return res.status(404).json({ success: false, message: "Leave not found" });

    // Employees can only view their own
    if (
      req.user.role === "employee" &&
      leave.user_id._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    return res.status(200).json({ success: true, data: leave });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── APPROVE / REJECT (admin / manager) ─────────────────────────────────────
/**
 * PATCH /leaves/:id
 * Body: { status: "approved" | "rejected", admin_note? }
 *
 * When status is "approved":
 *   1. Updates user status to "on-leave"
 *   2. Triggers auto-reassignment of urgent tasks during leave period
 */
const updateLeaveStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid leave ID" });

    const { status, admin_note } = req.body;
    if (!["approved", "rejected"].includes(status))
      return res.status(400).json({ success: false, message: 'status must be "approved" or "rejected"' });

    const leave = await Leave.findById(id).populate("user_id", "name email");
    if (!leave)
      return res.status(404).json({ success: false, message: "Leave not found" });
    if (leave.status !== "pending")
      return res.status(400).json({ success: false, message: "Only pending leaves can be reviewed" });

    leave.status      = status;
    leave.admin_note  = admin_note || null;
    leave.reviewed_by = req.user._id;
    leave.reviewed_at = new Date();
    await leave.save();

    // Notify the applicant
    await Notification.create({
      user_id:   leave.user_id._id,
      sender_id: req.user._id,
      message:   status === "approved"
        ? `✅ Your leave from ${leave.from_date.toDateString()} to ${leave.to_date.toDateString()} has been approved.`
        : `❌ Your leave request has been rejected. ${admin_note ? "Note: " + admin_note : ""}`,
      type:      "general",
      ref_id:    leave._id,
      ref_type:  null,
    }).catch(console.error);

    let reassignedTasks = [];

    if (status === "approved") {
      // Update user status to on-leave
      await User.findByIdAndUpdate(leave.user_id._id, { status: "on-leave" });

      // ── Auto-reassign urgent tasks during leave period ──────────────────
      try {
        reassignedTasks = await handleLeaveReassignment(
          leave.user_id._id,
          leave.from_date,
          leave.to_date,
          req.user._id
        );
      } catch (reassignErr) {
        console.error("Leave reassignment error:", reassignErr.message);
        // Non-fatal — log but don't fail the response
      }
    }

    return res.status(200).json({
      success: true,
      message: `Leave ${status}`,
      data: leave,
      reassigned_tasks: reassignedTasks.length,
      reassigned_task_ids: reassignedTasks.map((t) => t._id),
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── CANCEL LEAVE ────────────────────────────────────────────────────────────

const cancelLeave = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid leave ID" });

    const leave = await Leave.findById(id);
    if (!leave)
      return res.status(404).json({ success: false, message: "Leave not found" });

    const isOwner = leave.user_id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin)
      return res.status(403).json({ success: false, message: "Access denied" });

    if (isOwner && leave.status !== "pending")
      return res.status(400).json({
        success: false,
        message: "You can only cancel pending leave requests",
      });

    await Leave.findByIdAndDelete(id);

    // If cancelling an approved leave, restore user to active
    if (leave.status === "approved") {
      await User.findByIdAndUpdate(leave.user_id, { status: "active" });
    }

    return res.status(200).json({ success: true, message: "Leave cancelled" });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  getLeaveById,
  updateLeaveStatus,
  cancelLeave,
};
