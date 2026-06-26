const mongoose = require("mongoose");

const RawLogSchema = new mongoose.Schema(
  {
    time: { type: Date },
    type: { type: String },   // wrapped so Mongoose treats "type" as a field, not a type declaration
    verify: { type: String },
  },
  { _id: false }
);

const AttendanceSchema = mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: () => new Date().setHours(0, 0, 0, 0),
    },
    clock_in: {
      type: Date,
      required: true,
    },
    clock_out: {
      type: Date,
      default: null,
    },
    hours_worked: {
      type: Number,
      default: null,
      min: 0,
    },
    status: {
      type: String,
      enum: ["present", "absent", "late", "half-day", "on-leave"],
      default: "present",
    },

    // ─── eSSL Fingerprint Machine Integration ──────────────────────────────
    source: {
      type: String,
      enum: ["manual", "fingerprint"],
      default: "manual",           // "fingerprint" = came from eSSL device
    },
    device_serial: {
      type: String,
      default: null,               // serial number of the eSSL device that sent the record
    },
   raw_logs: {
      type: [RawLogSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Attendance", AttendanceSchema);
