const mongoose = require('mongoose');

/**
 * One desktop screenshot captured by the SkyUp Tracker agent (every 2 minutes
 * while tracking is on). The image itself lives on Cloudinary; this document
 * stores the URL + metadata so the admin dashboard can list a day's shots.
 *
 * Retention: rows (and their Cloudinary assets) older than
 * SCREENSHOT_RETENTION_DAYS are purged by purgeOldScreenshots() in
 * routes/trackerRoutes.js — deletion must go through Cloudinary too, which is
 * why a plain Mongo TTL index is NOT used here (it would orphan the images).
 */
const screenshotSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackerDevice', required: true },
    taken_at: { type: Date, required: true },
    url: { type: String, required: true },        // Cloudinary secure_url (full image)
    public_id: { type: String, required: true },  // Cloudinary asset id, needed for deletion
    screen: { type: String, default: '', maxlength: 60 },     // display name (multi-monitor)
    app_name: { type: String, default: '', maxlength: 120 },  // foreground app at capture time
    is_idle: { type: Boolean, default: false },
    width: { type: Number },
    height: { type: Number },
    bytes: { type: Number },
  },
  { timestamps: true }
);

// Main read pattern: one user's day
screenshotSchema.index({ user_id: 1, taken_at: 1 });
// Retention purge scan
screenshotSchema.index({ taken_at: 1 });

module.exports = mongoose.model('Screenshot', screenshotSchema);