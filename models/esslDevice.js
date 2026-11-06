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
  },
  { timestamps: true, collection: "essl_devices" }
);

module.exports = mongoose.model("EsslDevice", EsslDeviceSchema);
