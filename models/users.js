/**
 * models/users.js
 *
 * KEY FIX — pre('findOneAndUpdate') hook:
 *
 * The original hook was declared as:
 *   UserSchema.pre('findOneAndUpdate', async function (next) { ... next(); })
 *
 * In Mongoose, when you declare a pre-hook as async, Mongoose does NOT pass
 * `next` as a parameter — it uses the returned Promise instead. Calling next()
 * inside an async hook throws "next is not a function" because the argument
 * received is actually undefined (or the first real argument shifts).
 *
 * Fix: remove `next` from the signature entirely. Use `return` to exit early,
 * and let the async function's resolved Promise signal completion to Mongoose.
 */

const mongoose = require('mongoose');

// ── Sub-schema: one entry in designation history ──────────────────────────────

const DesignationHistorySchema = new mongoose.Schema(
  {
    designation: {
      type: String,
      required: true,
      trim: true,
    },
    fromDate: {
      type: Date,
      required: true,
    },
    toDate: {
      type: Date,
      default: null,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    supportingDoc: {
      type: String,
      default: null,
      trim: true,
    },
    note: {
      type: String,
      default: null,
      trim: true,
    },
  },
  { _id: true, timestamps: false }
);

// ── Main User schema ──────────────────────────────────────────────────────────

const UserSchema = mongoose.Schema(
  {
    // ── Core ──────────────────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, 'Please enter your name'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Enter your email'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Please enter a password'],
      minlength: 6,
      select: false,
    },
    phone:  { type: String, default: null },
    role: {
      type: String,
      enum: ['admin', 'manager', 'employee'],
      default: 'employee',
    },
    department: {
      type: String,
      required: [true, 'Mention the department'],
      trim: true,
    },
    designation: {
      type: String,
      required: [true, 'Mention the designation'],
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'on-leave'],
      default: 'active',
    },
    joining_date: {
      type: Date,
      default: Date.now,
    },
    dailyWorkingHours: {
      type: Number,
      default: 8,
      min: [1, 'Daily working hours must be at least 1'],
      max: [24, 'Daily working hours cannot exceed 24'],
    },

    // ── eSSL Fingerprint ──────────────────────────────────────────────────────
    fingerprint_id: {
      type: String,
      default: null,
      trim: true,
    },

    // ── Work mode / attendance ────────────────────────────────────────────────
    // work_mode is informational; attendance_override is an admin "always allow
    // manual clock" escape hatch (normally manual clock is gated by approved WFH).
    work_mode: {
      type: String,
      enum: ['office', 'wfh', 'hybrid'],
      default: 'office',
    },
    attendance_override: {
      type: Boolean,
      default: false,
    },

    // ── Personal ──────────────────────────────────────────────────────────────
    dateOfBirth:      { type: Date,   default: null },
    gender:           { type: String, default: null, trim: true },
    nationality:      { type: String, default: null, trim: true },
    maritalStatus:    { type: String, default: null, trim: true },
    permanentAddress: { type: String, default: null, trim: true },
    currentAddress:   { type: String, default: null, trim: true },

    // ── Emergency Contact ─────────────────────────────────────────────────────
    emergencyContactName:     { type: String, default: null, trim: true },
    emergencyContactRelation: { type: String, default: null, trim: true },
    emergencyContactPhone:    { type: String, default: null, trim: true },
    emergencyContactEmail:    { type: String, default: null, trim: true },

    // ── Fresher / Experience ──────────────────────────────────────────────────
    isFresher:           { type: Boolean, default: true },
    previousCompany:     { type: String,  default: null, trim: true },
    previousDesignation: { type: String,  default: null, trim: true },
    previousCTC:         { type: String,  default: null, trim: true },
    workExperienceYears: { type: Number,  default: null },
    reasonForLeaving:    { type: String,  default: null, trim: true },

    // ── Statutory / Professional ──────────────────────────────────────────────
    pfDetails:    { type: String, default: null, trim: true },
    uanNumber:    { type: String, default: null, trim: true },
    esicNumber:   { type: String, default: null, trim: true },
    panNumber:    { type: String, default: null, trim: true },
    aadhaarNumber:{ type: String, default: null, trim: true },

    // ── Banking ───────────────────────────────────────────────────────────────
    bankName:          { type: String, default: null, trim: true },
    accountNumber:     { type: String, default: null, trim: true },
    ifscCode:          { type: String, default: null, trim: true },
    accountHolderName: { type: String, default: null, trim: true },

    // ── Health ────────────────────────────────────────────────────────────────
    bloodGroup:               { type: String, default: null, trim: true },
    medicalConditions:        { type: String, default: null, trim: true },
    insuranceNomineeName:     { type: String, default: null, trim: true },
    insuranceNomineeRelation: { type: String, default: null, trim: true },

    // ── Legacy top-level doc paths ────────────────────────────────────────────
    salarySlip:            { type: String, default: null, trim: true },
    experienceCertificate: { type: String, default: null, trim: true },

    // ── Document upload paths ─────────────────────────────────────────────────
    documents: {
      aadhaar:      { type: String, default: null, trim: true },
      pan:          { type: String, default: null, trim: true },
      resume:       { type: String, default: null, trim: true },
      offerLetter:  { type: String, default: null, trim: true },
      certificates: [{ type: String, trim: true }],
    },

    // ── Designation history ───────────────────────────────────────────────────
    designationHistory: {
      type: [DesignationHistorySchema],
      default: [],
    },
  },
  { timestamps: true }
);

// ── Pre-hook: record old designation in history before update ─────────────────
//
// FIX: declared as `async function()` with NO `next` parameter.
//
// Why: Mongoose resolves async pre-hooks via the returned Promise, not via
// a next() callback. When you write `async function(next)`, the `next`
// argument is actually `undefined` because Mongoose passes nothing — calling
// it throws "next is not a function". Simply remove `next` and use `return`
// to exit early; the resolved Promise is what signals Mongoose to continue.
//
// The controller attaches metadata via query._meta before calling .exec():
//   query._meta = { changedBy, supportingDoc, note }

UserSchema.pre('findOneAndUpdate', async function () {
  const update = this.getUpdate();
  const newDesignation = update?.$set?.designation;

  // Only run when designation is actually being changed
  if (!newDesignation) return;

  try {
    const doc = await this.model
      .findOne(this.getFilter())
      .select('designation joining_date createdAt designationHistory');

    // No doc found, or designation hasn't changed — nothing to record
    if (!doc) return;
    if (!doc.designation || doc.designation === newDesignation) return;

    // Derive fromDate for the outgoing designation:
    //   - If history exists, the current designation started when the last
    //     history entry ended (its toDate).
    //   - Otherwise fall back to joining_date → createdAt → now.
    const history = doc.designationHistory ?? [];
    const fromDate = history.length > 0
      ? (history[history.length - 1].toDate ?? doc.joining_date ?? doc.createdAt ?? new Date())
      : (doc.joining_date ?? doc.createdAt ?? new Date());

    const now  = new Date();
    const meta = this._meta || {};

    const historyEntry = {
      designation:  doc.designation,
      fromDate,
      toDate:       now,
      changedAt:    now,
      changedBy:    meta.changedBy     || null,
      supportingDoc: meta.supportingDoc || null,
      note:         meta.note          || null,
    };

    if (!update.$push) update.$push = {};
    update.$push.designationHistory = historyEntry;

  } catch (err) {
    // Log but never block the save — history failure must not kill the update
    console.error('[User pre-hook] designationHistory push failed:', err.message);
  }
  // No next() call — async function return resolves the Promise for Mongoose
});

// ── Indexes ───────────────────────────────────────────────────────────────────
UserSchema.index({ role: 1, status: 1 });
UserSchema.index({ department: 1 });
UserSchema.index({ fingerprint_id: 1 }, { sparse: true });

const User = mongoose.model('User', UserSchema);
module.exports = User;