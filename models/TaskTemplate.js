/**
 * models/TaskTemplate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin-managed, per-service task template.
 *
 * When a project is created whose `project_type` matches a template's
 * `projectType`, the template's tasks (with subtasks) are turned into real
 * Task documents — fully REPLACING AI/auto phase generation for that project.
 *
 * `projectType` is stored as a normalised slug (lowercase, spaces/hyphens →
 * underscore) so it lines up 1:1 with the frontend PROJECT_TYPES values
 * (e.g. "website_development", "graphic_design", "email_marketing").
 *
 * Field names deliberately match services/templateService.js
 * (generateTasksFromTemplate): name, description, designation, department,
 * estimatedHours, priority, subtasks[].name
 */

const mongoose = require("mongoose");

// ── Subtask inside a template task ────────────────────────────────────────────
const TemplateSubtaskSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Subtask name is required"], trim: true },
  },
  { _id: true }
);

// ── A single task inside a template ───────────────────────────────────────────
const TemplateTaskSchema = new mongoose.Schema(
  {
    name:        { type: String, required: [true, "Task name is required"], trim: true },
    description: { type: String, default: null, trim: true },

    // Role used to auto-assign an employee (matched against User.designation/role)
    designation: { type: String, default: null, trim: true },
    department:  { type: String, default: null, trim: true },

    // OPTIONAL: pin this task to a SPECIFIC employee. When set, it takes
    // priority over designation/department role-matching at generation time.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    estimatedHours: { type: Number, default: 8, min: 1 },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },

    // OPTIONAL: phase gating (1 = Design · 2 = Development · 3 = Testing & Deploy).
    // When set, generated Task docs inherit it and are gated accordingly.
    phase:     { type: Number, default: null },
    phaseName: { type: String, default: null, trim: true },

    subtasks: { type: [TemplateSubtaskSchema], default: [] },
  },
  { _id: true }
);

// ── The template document ─────────────────────────────────────────────────────
const TaskTemplateSchema = new mongoose.Schema(
  {
    // Human-readable label, e.g. "Website Development"
    name: { type: String, required: [true, "Template name is required"], trim: true },

    // Normalised slug tying the template to a project type. UNIQUE + indexed.
    projectType: {
      type: String,
      required: [true, "projectType is required"],
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },

    description: { type: String, default: null, trim: true },

    isActive: { type: Boolean, default: true, index: true },

    tasks: { type: [TemplateTaskSchema], default: [] },

    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Always store projectType as a clean slug regardless of what the client sends.
TaskTemplateSchema.pre("validate", function () {
  if (this.projectType) {
    this.projectType = this.projectType
      .toLowerCase()
      .trim()
      .replace(/[\s\-]+/g, "_");
  }
});

const TaskTemplate = mongoose.model("TaskTemplate", TaskTemplateSchema);
module.exports = TaskTemplate;