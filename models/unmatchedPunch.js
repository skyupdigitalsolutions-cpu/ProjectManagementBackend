/**
 * models/unmatchedPunch.js
 * Punches from the fingerprint machine whose Device ID doesn't belong to any
 * employee yet (no user has it as fingerprint_id or employee_id). They used to
 * be thrown away; now they're kept here (one document per Device ID) so an
 * admin can see which IDs are unassigned, and when the ID is assigned to
 * someone, these punches are imported into their attendance.
 */
const mongoose = require("mongoose");

const PunchSchema = new mongoose.Schema(
  {
    time: { type: Date, required: true },   // already corrected for the machine clock
    type: { type: String },
    verify: { type: String },
    clock_offset_applied: { type: Number },
    device_serial: { type: String, default: null },
  },
  { _id: false }
);

const UnmatchedPunchSchema = new mongoose.Schema(
  {
    device_id: { type: String, required: true, unique: true, trim: true },
    punches: { type: [PunchSchema], default: [] },     // newest kept, capped
    count: { type: Number, default: 0 },               // total punches seen
    first_seen: { type: Date, default: null },
    last_seen: { type: Date, default: null },
  },
  { timestamps: true, collection: "essl_unmatched_punches" }
);

module.exports = mongoose.model("UnmatchedPunch", UnmatchedPunchSchema);
module.exports.MAX_KEPT = 1000;
