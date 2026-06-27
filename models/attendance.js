const mongoose = require("mongoose");

const RawLogSchema = new mongoose.Schema(
  {
    time: { type: Date },
    type: { type: String },   // wrapped so Mongoose treats "type" as a field, not a type declaration
    verify: { type: String },
  },
  { _id: false }
);

// One break taken during the day (app-recorded). `end` is null while on break.
const BreakSchema = new mongoose.Schema(
  {
    start: { type: Date, required: true },
    end:   { type: Date, default: null },
  },
  { _id: true }
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
    // Breaks taken through the application during the work session.
    breaks: {
      type: [BreakSchema],
      default: [],
    },
    break_minutes: {
      type: Number,
      default: 0,
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
      enum: ["manual", "fingerprint", "wfh"],
      default: "manual",           // "fingerprint" = eSSL device · "wfh" = approved work-from-home
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