/**
 * controllers/taskTemplateController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin CRUD for per-service task templates.
 *
 *   GET    /api/task-templates            list all (optional ?activeOnly=true)
 *   GET    /api/task-templates/:id        get one
 *   POST   /api/task-templates            create
 *   PUT    /api/task-templates/:id        update (full replace of fields sent)
 *   DELETE /api/task-templates/:id        delete
 *
 * projectType uniqueness is enforced at the schema level; we translate the
 * Mongo duplicate-key error into a friendly 409.
 */

const TaskTemplate = require("../models/TaskTemplate");

// Whitelist + shape the tasks array coming from the client so no stray fields
// or malformed subtasks reach the DB.
function sanitizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && String(t.name || "").trim() !== "")
    .map((t) => ({
      name:           String(t.name).trim(),
      description:    t.description ? String(t.description).trim() : null,
      designation:    t.designation ? String(t.designation).trim() : null,
      department:     t.department ? String(t.department).trim() : null,
      assignedTo:     t.assignedTo && String(t.assignedTo).match(/^[0-9a-fA-F]{24}$/)
        ? t.assignedTo
        : null,
      estimatedHours: Number(t.estimatedHours) > 0 ? Number(t.estimatedHours) : 8,
      priority:       ["low", "medium", "high", "critical"].includes(t.priority)
        ? t.priority
        : "medium",
      subtasks: Array.isArray(t.subtasks)
        ? t.subtasks
            .filter((s) => s && String(s.name || "").trim() !== "")
            .map((s) => ({ name: String(s.name).trim() }))
        : [],
    }));
}

// ── LIST ──────────────────────────────────────────────────────────────────────
const listTemplates = async (req, res) => {
  try {
    const filter = {};
    if (req.query.activeOnly === "true") filter.isActive = true;

    const templates = await TaskTemplate.find(filter).sort({ updatedAt: -1 });
    return res.json({ success: true, count: templates.length, data: templates });
  } catch (err) {
    console.error("[taskTemplate] list error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load templates" });
  }
};

// ── GET ONE ───────────────────────────────────────────────────────────────────
const getTemplate = async (req, res) => {
  try {
    const template = await TaskTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }
    return res.json({ success: true, data: template });
  } catch (err) {
    console.error("[taskTemplate] get error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load template" });
  }
};

// ── CREATE ────────────────────────────────────────────────────────────────────
const createTemplate = async (req, res) => {
  try {
    const { name, projectType, description, isActive, tasks } = req.body;

    if (!name || !projectType) {
      return res
        .status(400)
        .json({ success: false, message: "name and projectType are required" });
    }

    const template = await TaskTemplate.create({
      name:        String(name).trim(),
      projectType: String(projectType).trim(),
      description: description ? String(description).trim() : null,
      isActive:    isActive !== false,
      tasks:       sanitizeTasks(tasks),
      created_by:  req.user?._id || null,
      updated_by:  req.user?._id || null,
    });

    return res.status(201).json({ success: true, data: template });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A template already exists for this project type. Edit that one instead.",
      });
    }
    console.error("[taskTemplate] create error:", err.message);
    return res
      .status(400)
      .json({ success: false, message: err.message || "Failed to create template" });
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────
const updateTemplate = async (req, res) => {
  try {
    const template = await TaskTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }

    const { name, projectType, description, isActive, tasks } = req.body;

    if (name !== undefined)        template.name = String(name).trim();
    if (projectType !== undefined) template.projectType = String(projectType).trim();
    if (description !== undefined) template.description = description ? String(description).trim() : null;
    if (isActive !== undefined)    template.isActive = !!isActive;
    if (tasks !== undefined)       template.tasks = sanitizeTasks(tasks);
    template.updated_by = req.user?._id || null;

    await template.save();
    return res.json({ success: true, data: template });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Another template already uses this project type.",
      });
    }
    console.error("[taskTemplate] update error:", err.message);
    return res
      .status(400)
      .json({ success: false, message: err.message || "Failed to update template" });
  }
};

// ── DELETE ────────────────────────────────────────────────────────────────────
const deleteTemplate = async (req, res) => {
  try {
    const deleted = await TaskTemplate.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Template not found" });
    }
    return res.json({ success: true, message: "Template deleted" });
  } catch (err) {
    console.error("[taskTemplate] delete error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to delete template" });
  }
};

// ── GET TEMPLATE FOR A PROJECT TYPE (shaped for the create-project wizard) ─────
// GET /api/task-templates/for-project?projectType=website_development
// Returns the active template for that type, with each task's fields renamed
// to the keys the frontend wizard uses (title, required_role, assignee_id,
// estimated_hours, subTasks[]). 404 if no active template exists.
const getTemplateForProject = async (req, res) => {
  try {
    const raw = req.query.projectType || "";
    const slug = String(raw).toLowerCase().trim().replace(/[\s\-]+/g, "_");
    if (!slug) {
      return res.status(400).json({ success: false, message: "projectType is required" });
    }

    const template = await TaskTemplate.findOne({ projectType: slug, isActive: true });
    if (!template) {
      return res
        .status(404)
        .json({ success: false, message: "No active template for this project type" });
    }

    const tasks = (template.tasks || []).map((t) => ({
      title:           t.name,
      description:     t.description || "",
      required_role:   t.designation || t.department || "",
      // Wizard uses `assignee_id`; template stores `assignedTo`.
      assignee_id:     t.assignedTo ? String(t.assignedTo) : "",
      priority:        t.priority || "medium",
      estimated_hours: t.estimatedHours || "",
      subTasks: (t.subtasks || []).map((s) => ({ title: s.name })),
    }));

    return res.json({
      success: true,
      data: {
        _id:         template._id,
        name:        template.name,
        projectType: template.projectType,
        tasks,
      },
    });
  } catch (err) {
    console.error("[taskTemplate] for-project error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load template" });
  }
};

module.exports = {
  listTemplates,
  getTemplate,
  getTemplateForProject,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};