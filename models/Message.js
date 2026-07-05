/**
 * models/Message.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Employee-only group chat message. Read/written ONLY through the employee-chat
 * controller, which is locked to role === 'employee'. No admin/manager endpoint
 * ever returns these documents.
 *
 * NOTE: this hides messages at the application level. Anyone with direct
 * database access can still read the raw collection — true end-to-end secrecy
 * would require client-side encryption, which this does not implement.
 */

const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    // Room key — single shared employee room for now; kept for future channels.
    channel:   { type: String, default: 'employees', trim: true, index: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content:   { type: String, required: true, trim: true, maxlength: 4000 },
    deleted:   { type: Boolean, default: false },
  },
  { timestamps: true }
);

MessageSchema.index({ channel: 1, createdAt: -1 });

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);