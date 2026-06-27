const mongoose = require("mongoose");

// An attachment on a leave request. Wrapped in its own schema because the
// `type` field would otherwise be read by Mongoose as a SchemaType declaration
// (turning the whole object into a plain String path). The sub-schema makes
// `type` a real String field. _id disabled — these are simple value objects.
const LeaveDocumentSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    url:  { type: String, default: null },
    type: { type: String, default: null },
  },
  { _id: false }
);

const LeaveSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    leave_type: {
      type: String,
      enum: ["sick", "casual", "earned", "maternity", "emergency", "unpaid"],
      required: [true, "Leave type is required"],
    },
    from_date: {
      type: Date,
      required: [true, "From date is required"],
    },
    to_date: {
      type: Date,
      required: [true, "To date is required"],
    },
    days: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      required: [true, "Reason is required"],
      minlength: [20, "Reason must be at least 20 characters"],
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    is_urgent: {
      type: Boolean,
      default: false,
    },
    contact_during_leave: {
      type: String,
      default: null,
      trim: true,
    },
    handover_notes: {
      type: String,
      default: null,
      trim: true,
    },
    admin_note: {
      type: String,
      default: null,
      trim: true,
    },
    // reviewed by
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewed_at: {
      type: Date,
      default: null,
    },
    // optional document attachments (URLs from cloud storage)
    documents: {
      type: [LeaveDocumentSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Index for fast lookups by user and status
LeaveSchema.index({ user_id: 1, status: 1 });
LeaveSchema.index({ from_date: 1, to_date: 1 });

module.exports = mongoose.model("Leave", LeaveSchema);