/**
 * models/tasks.js  — UPDATED
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANGES vs original:
 *  1. `subtasks` field — upgraded from a single string to a proper array of
 *     SubtaskSchema sub-documents (title, assignedTo, status, priority, dueDate)
 *  2. Legacy string `subtask` field kept with `select: false` for backward compat
 * Everything else is identical.
 */

const mongoose = require('mongoose');

// ── Sub-schemas ────────────────────────────────────────────────────────────────

const DelayLogSchema = new mongoose.Schema(
  {
    reason:            { type: String, required: true, trim: true },
    reported_by:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reported_at:       { type: Date, default: Date.now },
    previous_due_date: { type: Date, default: null },
    new_due_date:      { type: Date, default: null },
  },
  { _id: true }
);

const ReassignLogSchema = new mongoose.Schema(
  {
    from_user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    to_user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason:        { type: String, trim: true, default: null },
    reassigned_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reassigned_at: { type: Date, default: Date.now },
    trigger: {
      type: String,
      enum: ['manual', 'leave_cover', 'auto_assign', 'priority_rebalance'],
      default: 'manual',
    },
  },
  { _id: true }
);

// ── NEW: Subtask sub-schema ────────────────────────────────────────────────────

const SubtaskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Subtask title is required'],
      trim: true,
    },
    description: {
      type: String,
      default: null,
      trim: true,
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: ['todo', 'in-progress', 'completed', 'on-hold', 'cancelled'],
      default: 'todo',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    due_date: {
      type: Date,
      default: null,
    },
    completed_at: {
      type: Date,
      default: null,
    },
  },
  { _id: true, timestamps: true }
);

// ── Main Task schema ───────────────────────────────────────────────────────────

const TasksSchema = mongoose.Schema(
  {
    project_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    assignment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assignment',
      default: null,
    },
    title:       { type: String, required: true, trim: true },
    description: { type: String, default: null, trim: true },

    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      required: false,
    },
    assigned_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── Module / auto-plan metadata ────────────────────────────────────────────
    module_name:    { type: String, default: null, trim: true },
    estimated_days: { type: Number, default: 1 },

    // ── Phase gating (Website Development workflow) ─────────────────────────────
    // 1 = Design & Planning · 2 = Development · 3 = Testing & Deployment
    // A task is locked from updates until all earlier-phase tasks in the same
    // project are completed. Null = not part of a phased workflow (never locked).
    phase:      { type: Number, default: null },
    phase_name: { type: String, default: null, trim: true },

    // When this task became workable (all earlier phases complete). The delay
    // clock starts here — a locked task is never counted as delayed.
    unlocked_at: { type: Date, default: null },

    // ── Day-wise scheduling ────────────────────────────────────────────────────
    start_date: { type: Date, default: null },
    end_date:   { type: Date, default: null },

    // ── Auto-assign metadata ───────────────────────────────────────────────────
    is_auto_assigned:   { type: Boolean, default: false },
    auto_assign_reason: { type: String, default: null, trim: true },

    // ── Permission / access request ────────────────────────────────────────────
    requires_permission:    { type: Boolean, default: false },
    permission_description: { type: String, default: null, trim: true },
    permission_status: {
      type: String,
      enum: ['not_required', 'pending', 'granted', 'denied'],
      default: 'not_required',
    },
    permission_granted_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    permission_granted_at: { type: Date, default: null },

    status: {
      type: String,
      enum: ['todo', 'in-progress', 'completed', 'on-hold', 'cancelled', 'blocked', 'unassigned'],
      default: 'todo',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
      default: 'medium',
    },

    priority_score: { type: Number, default: 0 },

    due_date: { type: Date, required: true },

    estimated_hours: { type: Number, default: null },
    actual_hours:    { type: Number, default: null },
    completed_at:    { type: Date, default: null },

    // ── Progress ───────────────────────────────────────────────────────────────
    progress_percent: { type: Number, default: 0, min: 0, max: 100 },

    // ── Delay tracking ─────────────────────────────────────────────────────────
    delay_logs:   [DelayLogSchema],
    is_delayed:   { type: Boolean, default: false },
    delay_reason: { type: String, default: null, trim: true },

    // ── Reassignment history ───────────────────────────────────────────────────
    reassign_logs: [ReassignLogSchema],

    // ── Department / role tag ──────────────────────────────────────────────────
    required_role:       { type: String, default: null, trim: true },
    required_department: { type: String, default: null, trim: true },

    // ── Excel import flag ──────────────────────────────────────────────────────
    excel_import:       { type: Boolean, default: false, index: true },

    // ── Dependency ────────────────────────────────────────────────────────────
    dependency_task_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null },

    // ── SUBTASKS (NEW — replaces the old plain-string `subtask` field) ─────────
    subtasks: {
      type: [SubtaskSchema],
      default: [],
    },

    // Legacy string subtask kept for backward-compat (hidden from default queries)
    subtask: { type: String, default: null, trim: true, select: false },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

TasksSchema.index({ assigned_to: 1, status: 1, priority: -1 });
TasksSchema.index({ project_id: 1, status: 1 });
TasksSchema.index({ due_date: 1, is_delayed: 1 });
TasksSchema.index({ project_id: 1, module_name: 1 });
TasksSchema.index({ start_date: 1, end_date: 1 });
TasksSchema.index({ project_id: 1, excel_import: 1 });
TasksSchema.index({ dependency_task_id: 1 });

const Task = mongoose.model('Task', TasksSchema);
module.exports = Task;