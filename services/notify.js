/**
 * services/notify.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Small helper to fan a notification out to every admin. Used for task updates,
 * leave requests, WFH requests, and daily-report submissions coming from the
 * employee side. Never throws — notification failures must not break the request.
 */

const User = require('../models/users');
const Notification = require('../models/notification');

/**
 * Create an inbox notification for all active admins.
 *
 * @param {Object}  opts
 * @param {string}  opts.message                 Notification text (required)
 * @param {string} [opts.type='general']         Must be a value in the Notification enum
 * @param {ObjectId|string} [opts.ref_id=null]   Related document id
 * @param {string} [opts.ref_type=null]          One of the Notification.ref_type enum values
 * @param {ObjectId|string} [opts.sender_id=null] The user that triggered it
 * @param {ObjectId|string} [opts.excludeUserId=null] Skip this admin (e.g. if they acted themselves)
 */
async function notifyAdmins({
  message,
  type = 'general',
  ref_id = null,
  ref_type = null,
  sender_id = null,
  excludeUserId = null,
} = {}) {
  try {
    if (!message) return;

    const admins = await User.find({ role: 'admin', status: { $ne: 'inactive' } })
      .select('_id')
      .lean();

    let recipients = admins.map((a) => a._id);
    if (excludeUserId) {
      recipients = recipients.filter((id) => id.toString() !== excludeUserId.toString());
    }
    if (recipients.length === 0) return;

    const docs = recipients.map((user_id) => ({
      user_id,
      sender_id,
      message,
      type,
      ref_id: ref_id || null,
      ref_type: ref_type || null,
      is_sent: false,
    }));

    await Notification.insertMany(docs);
  } catch (err) {
    console.error('[notifyAdmins] failed:', err.message);
  }
}

module.exports = { notifyAdmins };