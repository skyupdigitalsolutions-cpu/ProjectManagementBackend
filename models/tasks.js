const mongoose = require("mongoose");

const DelayLogSchema = new mongoose.Schema(
  {
    reason: { type: String, required: true, trim: true },
    reported_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reported_at: { type: Date, default: Date.now },
    previous_due_date: { type: Date, default: null },
    new_due_date: { type: Date, default: null },
  },
  { _id: true }
);

const ReassignLogSchema = new mongoose.Schema(
  {
    from_user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    to_user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reason:    { type: String, trim: true, default: null },
    reassigned_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reassigned_at: { type: Date, default: Date.now },
    trigger: {
      type: String,
      enum: ["manual", "leave_cover", "auto_assign", "priority_rebalance"],
      default: "manual",
    },
  },
  { _id: true }
);

const TasksSchema = mongoose.Schema(
  {
    project_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    assignment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      default: null,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: null, trim: true },

    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assigned_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Module / auto-plan metadata ────────────────────────────────────────
    module_name: { type: String, default: null, trim: true },         // e.g. "Authentication"
    estimated_days: { type: Number, default: 1 },                     // used by scheduler (1–3 days per task)

    // ── Day-wise scheduling ────────────────────────────────────────────────
    start_date: { type: Date, default: null },                         // scheduled start
    end_date:   { type: Date, default: null },                         // scheduled end

    // ── Auto-assign metadata ───────────────────────────────────────────────
    is_auto_assigned: { type: Boolean, default: false },
    auto_assign_reason: { type: String, default: null, trim: true },

    // ── Permission / access request ──────────────────────────────────────
    requires_permission: { type: Boolean, default: false },
    permission_description: { type: String, default: null, trim: true },
    permission_status: {
      type: String,
      enum: ["not_required", "pending", "granted", "denied"],
      default: "not_required",
    },
    permission_granted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    permission_granted_at: { type: Date, default: null },

    status: {
      type: String,
      enum: ["todo", "in-progress", "completed", "on-hold", "cancelled", "blocked"],
      default: "todo",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      required: true,
      default: "medium",
    },

    // numeric score used for smart sorting (higher = do first)
    priority_score: { type: Number, default: 0 },

    // due_date kept for backward compat — mirrors end_date when auto-scheduled
    due_date: { type: Date, required: true },

    estimated_hours: { type: Number, default: null },
    actual_hours: { type: Number, default: null },
    completed_at: { type: Date, default: null },

    // ── Progress tracking ─────────────────────────────────────────────────
    progress_percent: { type: Number, default: 0, min: 0, max: 100 },

    // ── Delay tracking ────────────────────────────────────────────────────
    delay_logs: [DelayLogSchema],
    is_delayed: { type: Boolean, default: false },
    delay_reason: { type: String, default: null, trim: true },

    // ── Reassignment history ──────────────────────────────────────────────
    reassign_logs: [ReassignLogSchema],

    // ── Department / role tag (for smart matching) ────────────────────────
    required_role: { type: String, default: null, trim: true },         // e.g. "frontend developer"
    required_department: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

// Fast lookup indexes
TasksSchema.index({ assigned_to: 1, status: 1, priority: -1 });
TasksSchema.index({ project_id: 1, status: 1 });
TasksSchema.index({ due_date: 1, is_delayed: 1 });
TasksSchema.index({ project_id: 1, module_name: 1 });        // for module-grouped views
TasksSchema.index({ start_date: 1, end_date: 1 });            // for Gantt/timeline queries

const Task = mongoose.model("Task", TasksSchema);
module.exports = Task;
