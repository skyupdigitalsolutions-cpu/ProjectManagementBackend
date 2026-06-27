/**
 * models/policy.js
 *
 * The Policy Settings UI and services/attendanceEngine.js both expect these
 * field names (weekly_offs, leave_types[], half_day_hours, full_day_hours,
 * late_threshold_minutes, comp_off_*). The previous model was missing them, so
 * the values were silently dropped on save and never returned on read — which is
 * why weekly-offs wouldn't stick, Leave Rules showed nothing, and comp-off
 * couldn't be configured. This model is the superset the rest of the app needs.
 */
const mongoose = require('mongoose');

const HolidaySchema = new mongoose.Schema(
  {
    date:        { type: Date,    required: true },
    name:        { type: String,  required: true, trim: true },
    description: { type: String,  default: null, trim: true },
    is_optional: { type: Boolean, default: false },
  },
  { _id: true }
);

// Per-leave-type configuration shown in the "Leave Rules" section.
const LeaveTypeSchema = new mongoose.Schema(
  {
    type:              { type: String,  required: true },   // key e.g. "sick"
    label:             { type: String,  required: true },
    is_paid:           { type: Boolean, default: true },
    carry_forward:     { type: Boolean, default: false },
    carry_forward_max: { type: Number,  default: 0 },
    allowed_per_month: { type: Number,  default: 0 },
    allowed_per_year:  { type: Number,  default: 0 },
  },
  { _id: false }
);

const DEFAULT_LEAVE_TYPES = [
  { type: 'sick',      label: 'Sick Leave',      is_paid: true,  carry_forward: false, carry_forward_max: 0,  allowed_per_month: 1, allowed_per_year: 12 },
  { type: 'casual',    label: 'Casual Leave',    is_paid: true,  carry_forward: false, carry_forward_max: 0,  allowed_per_month: 1, allowed_per_year: 12 },
  { type: 'earned',    label: 'Earned Leave',    is_paid: true,  carry_forward: true,  carry_forward_max: 30, allowed_per_month: 1, allowed_per_year: 15 },
  { type: 'maternity', label: 'Maternity Leave', is_paid: true,  carry_forward: false, carry_forward_max: 0,  allowed_per_month: 0, allowed_per_year: 90 },
  { type: 'emergency', label: 'Emergency Leave', is_paid: true,  carry_forward: false, carry_forward_max: 0,  allowed_per_month: 0, allowed_per_year: 3  },
  { type: 'unpaid',    label: 'Unpaid Leave',    is_paid: false, carry_forward: false, carry_forward_max: 0,  allowed_per_month: 0, allowed_per_year: 0  },
];

const PolicySchema = new mongoose.Schema(
  {
    title: { type: String, default: 'Company Policy', trim: true },
    year:  { type: Number, default: () => new Date().getFullYear() },

    // ── Working hours ─────────────────────────────────────────────────────────
    work_start_time:        { type: String, default: '09:00' },   // "HH:mm"
    work_end_time:          { type: String, default: '18:00' },
    late_threshold_minutes: { type: Number, default: 15 },        // grace before "late"
    half_day_hours:         { type: Number, default: 4 },
    full_day_hours:         { type: Number, default: 8 },
    weekly_offs:            { type: [Number], default: () => [0, 6] }, // 0=Sun … 6=Sat

    // ── Leave rules ──────────────────────────────────────────────────────────
    leave_types: { type: [LeaveTypeSchema], default: () => DEFAULT_LEAVE_TYPES },

    // ── Comp-off ─────────────────────────────────────────────────────────────
    comp_off_enabled:       { type: Boolean, default: true },
    comp_off_on_holiday:    { type: Boolean, default: true },
    comp_off_on_weekend:    { type: Boolean, default: true },
    min_hours_for_comp_off: { type: Number,  default: 8 },
    comp_off_expiry_days:   { type: Number,  default: 90 },

    // ── WFH policy ───────────────────────────────────────────────────────────
    wfh_allowed:           { type: Boolean, default: true },
    wfh_days_per_month:    { type: Number,  default: 8 },
    wfh_requires_approval: { type: Boolean, default: true },

    // ── Holidays ─────────────────────────────────────────────────────────────
    holidays: { type: [HolidaySchema], default: [] },

    // ── Legacy fields (kept for backward compatibility) ──────────────────────
    daily_hours:        { type: Number, default: 8 },
    late_grace_minutes: { type: Number, default: 15 },
    leave_entitlements: {
      sick:      { type: Number, default: 12 },
      casual:    { type: Number, default: 12 },
      earned:    { type: Number, default: 15 },
      maternity: { type: Number, default: 90 },
      emergency: { type: Number, default: 3  },
      unpaid:    { type: Number, default: 0  },
    },

    is_active:  { type: Boolean, default: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

PolicySchema.index({ is_active: 1 });

module.exports = mongoose.models.Policy || mongoose.model('Policy', PolicySchema);