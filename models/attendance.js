const mongoose = require("mongoose");

const RawLogSchema = new mongoose.Schema(
  {
    time: { type: Date },
    type: { type: String },   // wrapped so Mongoose treats "type" as a field, not a type declaration
    verify: { type: String },
    // Minutes of machine-clock correction already added to `time`
    // (Policy.device_clock_offset_minutes at the moment it was saved).
    // Missing on punches saved before this existed = not corrected yet.
    clock_offset_applied: { type: Number },
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

    // ─── Admin marking (Attendance Admin app) ─────────────────────────────
    // remark: a note an admin adds to the day (shown in the app and reports).
    remark:         { type: String, trim: true, maxlength: 500, default: "" },
    remark_by:      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    remark_by_name: { type: String, default: null },
    remark_at:      { type: Date, default: null },
    // admin_locked: an admin set this day's status / times / work from home.
    // Fingerprint punches are still logged in raw_logs, but never change the
    // admin's clock_in, clock_out, hours, status or source.
    admin_locked:   { type: Boolean, default: false },
    // no_times: marked without a login time (e.g. work from home, absent).
    // clock_in is required by this schema, so it holds 00:00 IST and is ignored.
    no_times:       { type: Boolean, default: false },
    marked_by:      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    marked_by_name: { type: String, default: null },
    marked_at:      { type: Date, default: null },
   raw_logs: {
      type: [RawLogSchema],
      default: [],
    },

    // ─── Alert guards ──────────────────────────────────────────────────────
    // Prevent duplicate Telegram/in-app alerts when the biometric device
    // re-sends the same punches on every ADMS interval.
    login_notified: {
      type: Boolean,
      default: false,      // real-time "clocked in" ping already sent
    },
    overtime_alerted: {
      type: Boolean,
      default: false,      // overtime alert already sent for this record
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Attendance", AttendanceSchema);
