const mongoose = require('mongoose');

/**
 * The employee's stated reason for an idle stretch of 4+ minutes, submitted
 * from the SkyUp Tracker prompt when they return to the machine.
 *
 * reason_id is the tracker-generated UUID of the idle activity entry, so a
 * retried upload can never create a duplicate (unique index below).
 */
const idleReasonSchema = new mongoose.Schema(
  {
    reason_id: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackerDevice', required: true },
    idle_start: { type: Date, required: true },
    idle_end: { type: Date, required: true },
    duration_sec: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// Main read pattern: one user's day (dashboard) and whole-day scans (digest)
idleReasonSchema.index({ user_id: 1, idle_start: 1 });
idleReasonSchema.index({ idle_start: 1 });

module.exports = mongoose.model('IdleReason', idleReasonSchema);