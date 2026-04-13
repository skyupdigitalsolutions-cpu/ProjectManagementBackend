const mongoose = require("mongoose");

const NotificationSchema = mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,               // who receives the notification (or sender for outbox copy)
    },
    sender_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,                // who sent the notification (null = system)
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: [
        "task_assigned",
        "task_updated",
        "task_completed",
        "project_assigned",
        "project_updated",
        "member_added",
        "member_removed",
        "deadline_reminder",
        "general",
        "meeting_invite",
      ],
      required: true,
    },
    is_read: {
      type: Boolean,
      default: false,
    },
    ref_id: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    ref_type: {
      type: String,
      enum: ["Task", "Project", "User", "ProjectMember", "Meeting", null],
      default: null,
    },
    // ── Outbox fields ──────────────────────────────────────────────────────
    is_sent: {
      type: Boolean,
      default: false,               // true = this doc is the sender's outbox copy
    },
    recipient_count: {
      type: Number,
      default: null,                // how many users received it (outbox only)
    },
  },
  { timestamps: true }
);

NotificationSchema.index({ user_id: 1, is_read: 1 });
NotificationSchema.index({ sender_id: 1, is_sent: 1 });

const Notification = mongoose.model("Notification", NotificationSchema);
module.exports = Notification;
