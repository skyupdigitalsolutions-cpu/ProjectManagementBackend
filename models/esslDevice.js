/**
 * models/esslDevice.js — one document per fingerprint machine (by serial number).
 * Remembers when it last contacted the server, the users enrolled on it (as the
 * machine reports them), and a small queue of commands for it. The machine picks
 * up commands when it polls GET /iclock/getrequest, and confirms them on
 * POST /iclock/devicecmd.
 */
const mongoose = require("mongoose");

const CommandSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true },              // number the machine echoes back
    cmd: { type: String, required: true },             // e.g. "DATA QUERY ATTLOG StartTime=...\tEndTime=..."
    label: { type: String, default: "" },              // human text for the admin app
    status: { type: String, enum: ["queued", "sent", "done", "failed"], default: "queued" },
    result: { type: String, default: "" },
    created_by: { type: String, default: "" },
    created_at: { type: Date, default: Date.now },
    sent_at: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    done_at: { type: Date, default: null },
  },
  { _id: false }
);

const MachineUserSchema = new mongoose.Schema(
  {
    pin: { type: String, required: true },             // the machine's user number (= Device ID)
    name: { type: String, default: "" },
    card: { type: String, default: "" },
    privilege: { type: String, default: "" },
  },
  { _id: false }
);

const EsslDeviceSchema = new mongoose.Schema(
  {
    serial: { type: String, required: true, unique: true, trim: true },
    last_seen: { type: Date, default: null },
    last_ip: { type: String, default: "" },
    last_punches_at: { type: Date, default: null },     // last ATTLOG upload
    last_punches_count: { type: Number, default: 0 },
    next_cmd_id: { type: Number, default: 1 },
    commands: { type: [CommandSchema], default: [] },   // newest last, trimmed to 50
    users: { type: [MachineUserSchema], default: [] },
    users_updated_at: { type: Date, default: null },
    // Last time the machine re-connected (GET /iclock/cdata?options=all) and what it said about itself
    last_handshake_at: { type: Date, default: null },
    last_handshake_query: { type: String, default: "" },
    // "Upload everything again" (works on all firmware): at the next connection the server
    // answers with ATTLOGStamp=0 / OPERLOGStamp=0, so the machine re-sends all punches and users.
    resend_all: { type: Boolean, default: false },
    resend_all_requested_at: { type: Date, default: null },
    resend_all_sent_at: { type: Date, default: null },
    // Calls from the machine to /iclock paths the server doesn't know (for diagnosis)
    unknown_calls: { type: [String], default: [] },
  },
  { timestamps: true, collection: "essl_devices" }
);

module.exports = mongoose.model("EsslDevice", EsslDeviceSchema);
