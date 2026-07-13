/**
 * models/Message.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Employee-only group chat message. Read/written ONLY through the employee-chat
 * controller, which is locked to role === 'employee'. No admin/manager endpoint
 * ever returns these documents.
 *
 * A message now carries any of:
 *   - content      : the text body (may be empty when only files are sent)
 *   - attachments  : uploaded images / videos / files (stored on Cloudinary)
 *   - mentions     : employees @-mentioned in the text
 *
 * NOTE: this hides messages at the application level. Anyone with direct
 * database access can still read the raw collection — true end-to-end secrecy
 * would require client-side encryption, which this does not implement.
 */

const mongoose = require('mongoose');

// One uploaded file. `resource_type` mirrors Cloudinary's classification
// ('image' | 'video' | 'raw') so the client knows how to render it.
const AttachmentSchema = new mongoose.Schema(
  {
    url:           { type: String, required: true },
    name:          { type: String, default: '' },   // original filename
    type:          { type: String, default: '' },   // mimetype, e.g. image/png
    resource_type: { type: String, default: 'raw', enum: ['image', 'video', 'raw'] },
    bytes:         { type: Number, default: 0 },
    width:         { type: Number },
    height:        { type: Number },
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    // Room key — single shared employee room for now; kept for future channels.
    channel:   { type: String, default: 'employees', trim: true, index: true },
    sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Text is optional now — a message can be attachments-only. The controller
    // enforces that at least one of content/attachments is present.
    content:     { type: String, default: '', trim: true, maxlength: 4000 },
    attachments: { type: [AttachmentSchema], default: [] },
    mentions:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

MessageSchema.index({ channel: 1, createdAt: -1 });

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);