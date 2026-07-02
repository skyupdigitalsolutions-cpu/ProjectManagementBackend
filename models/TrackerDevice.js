const mongoose = require('mongoose');

const trackerDeviceSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device_name: { type: String, required: true, trim: true },
    platform: { type: String, default: 'win32' },
    is_active: { type: Boolean, default: true }, // admin kill-switch: set false to revoke
    is_tracking: { type: Boolean, default: false },
    last_seen: { type: Date, default: null }
  },
  { timestamps: true }
);

trackerDeviceSchema.index({ user_id: 1 });
trackerDeviceSchema.index({ last_seen: 1 });

module.exports = mongoose.model('TrackerDevice', trackerDeviceSchema);