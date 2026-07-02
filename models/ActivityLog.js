const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema(
  {
    // Client-generated UUID -> makes bulk uploads idempotent (agent retries safely)
    entry_id: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackerDevice', required: true },
    app_name: { type: String, required: true, trim: true },
    window_title: { type: String, default: '', trim: true, maxlength: 300 },
    is_idle: { type: Boolean, default: false },
    task_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    duration_sec: { type: Number, required: true, min: 0 }
  },
  { timestamps: true }
);

// Main read pattern: one user's day / date range
activityLogSchema.index({ user_id: 1, start: 1 });
// Company-wide daily aggregation
activityLogSchema.index({ start: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);