/**
 * models/wfhRequest.js
 */
const mongoose = require('mongoose');

const WfhRequestSchema = new mongoose.Schema(
  {
    user_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    from_date: { type: Date, required: true },
    to_date:   { type: Date, required: true },
    reason:    { type: String, required: true, trim: true },
    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    admin_note: { type: String, default: null, trim: true },
    reviewed_by: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    reviewed_at: { type: Date, default: null },
  },
  { timestamps: true }
);

WfhRequestSchema.index({ user_id: 1, status: 1 });
WfhRequestSchema.index({ status: 1, from_date: -1 });

module.exports = mongoose.models.WfhRequest || mongoose.model('WfhRequest', WfhRequestSchema);