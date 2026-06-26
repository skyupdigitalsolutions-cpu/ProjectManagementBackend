/**
 * models/policy.js
 */
const mongoose = require('mongoose');

const HolidaySchema = new mongoose.Schema(
  {
    date:        { type: Date,   required: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: null, trim: true },
  },
  { _id: true }
);

const PolicySchema = new mongoose.Schema(
  {
    // Label to identify this policy version
    title: {
      type:    String,
      default: 'Company Policy',
      trim:    true,
    },

    // Working hours
    work_start_time:   { type: String, default: '09:00' },  // "HH:mm"
    work_end_time:     { type: String, default: '18:00' },
    daily_hours:       { type: Number, default: 8 },
    late_grace_minutes:{ type: Number, default: 15 },       // grace period before marking "late"

    // Leave entitlements (days per year)
    leave_entitlements: {
      sick:      { type: Number, default: 12 },
      casual:    { type: Number, default: 12 },
      earned:    { type: Number, default: 15 },
      maternity: { type: Number, default: 90 },
      emergency: { type: Number, default: 3  },
      unpaid:    { type: Number, default: 0  },
    },

    // WFH policy
    wfh_allowed:          { type: Boolean, default: true  },
    wfh_days_per_month:   { type: Number,  default: 8     },
    wfh_requires_approval:{ type: Boolean, default: true  },

    // Public / company holidays
    holidays: { type: [HolidaySchema], default: [] },

    // Only one active policy at a time
    is_active: { type: Boolean, default: true },

    created_by: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
  },
  { timestamps: true }
);

PolicySchema.index({ is_active: 1 });

module.exports = mongoose.models.Policy || mongoose.model('Policy', PolicySchema);