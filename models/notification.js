const mongoose = require("mongoose");

const NotificationSchema = mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sender_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    message: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: [
        "task_assigned",
        "task_updated",
        "task_completed",
        "task_delayed",
        "task_reassigned",
        "task_blocked",
        "project_assigned",
        "project_updated",
        "member_added",
        "member_removed",
        "deadline_reminder",
        "permission_requested",
        "permission_granted",
        "permission_denied",
        "leave_cover_assigned",
        "auto_assign",
        "general",
        "meeting_invite",
        // ── NEW: added for cron scheduler and smart assignment ──────────
        "task_reminder",   // daily 9AM briefing sent by cronScheduler.js
        "system_alert",    // admin alerts (overdue count, no-employee warnings)
        "approval_requested", // employee asks approval on a project or general item
        // ── NEW: employee-side activity notifications to admins ─────────────
        "leave_requested",        // employee applied for leave
        "wfh_requested",          // employee submitted a WFH request
        "daily_report_submitted", // employee submitted their daily report
      ],
      required: true,
    },
    is_read: { type: Boolean, default: false },
    ref_id:  { type: mongoose.Schema.Types.ObjectId, default: null },
    ref_type: {
      type: String,
      enum: ["Task", "Project", "User", "ProjectMember", "Meeting", "Assignment", null],
      default: null,
    },
    is_sent:         { type: Boolean, default: false },
    recipient_count: { type: Number, default: null },
    // Recipients this (outbox) notification was sent to — used to show
    // "To: …" in the admin/manager Sent tab.
    recipient_ids:   [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

NotificationSchema.index({ user_id: 1, is_read: 1 });
NotificationSchema.index({ sender_id: 1, is_sent: 1 });

const Notification = mongoose.model("Notification", NotificationSchema);
module.exports = Notification;