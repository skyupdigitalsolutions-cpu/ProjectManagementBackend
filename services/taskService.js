/**
 * services/taskService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-creates tasks and assigns employees based on projectType.
 * Called after project creation (non-blocking / fire-and-forget).
 *
 * Role-to-task mappings follow the pattern used in autoAssignService.js
 * so new tasks flow through the same pipeline.
 */

const mongoose = require('mongoose');
const Task     = require('../models/tasks');
const User     = require('../models/users');
const TaskTemplate = require('../models/TaskTemplate');

// ─── Template definitions ─────────────────────────────────────────────────────
// Each projectType maps to an ordered list of task templates.
// `requiredRole` is matched against User.designation (case-insensitive).

const PROJECT_TASK_TEMPLATES = {
  'Web Development': [
    { title: 'Gather requirements & create SRS',    requiredRole: 'Business Analyst',    priority: 'high',     estimated_days: 3 },
    { title: 'UI/UX wireframes & prototypes',        requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 5 },
    { title: 'Set up project repository & CI/CD',   requiredRole: 'DevOps Engineer',     priority: 'medium',   estimated_days: 2 },
    { title: 'Frontend development',                 requiredRole: 'Frontend Developer',  priority: 'high',     estimated_days: 10 },
    { title: 'Backend API development',              requiredRole: 'Backend Developer',   priority: 'high',     estimated_days: 10 },
    { title: 'Database design & setup',              requiredRole: 'Backend Developer',   priority: 'medium',   estimated_days: 3 },
    { title: 'Unit & integration testing',           requiredRole: 'QA Engineer',         priority: 'medium',   estimated_days: 5 },
    { title: 'UAT & bug fixes',                      requiredRole: 'QA Engineer',         priority: 'high',     estimated_days: 3 },
    { title: 'Deployment & go-live',                 requiredRole: 'DevOps Engineer',     priority: 'critical', estimated_days: 2 },
  ],

  'mobile_app': [
    { title: 'Requirements & app flow design',       requiredRole: 'Business Analyst',    priority: 'high',     estimated_days: 3 },
    { title: 'App UI/UX design',                     requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 6 },
    { title: 'iOS/Android development',              requiredRole: 'Mobile Developer',    priority: 'high',     estimated_days: 14 },
    { title: 'Backend API integration',              requiredRole: 'Backend Developer',   priority: 'high',     estimated_days: 7 },
    { title: 'Device & OS testing',                  requiredRole: 'QA Engineer',         priority: 'medium',   estimated_days: 5 },
    { title: 'App store submission',                 requiredRole: 'Mobile Developer',    priority: 'critical', estimated_days: 2 },
  ],

  'website': [
    { title: 'Content strategy & sitemap',           requiredRole: 'Content Writer',      priority: 'medium',   estimated_days: 2 },
    { title: 'Visual design & branding',             requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 5 },
    { title: 'Frontend development',                 requiredRole: 'Frontend Developer',  priority: 'high',     estimated_days: 8 },
    { title: 'CMS integration',                      requiredRole: 'Backend Developer',   priority: 'medium',   estimated_days: 3 },
    { title: 'SEO optimisation',                     requiredRole: 'SEO Specialist',      priority: 'medium',   estimated_days: 3 },
    { title: 'Cross-browser QA',                     requiredRole: 'QA Engineer',         priority: 'medium',   estimated_days: 2 },
    { title: 'Deployment',                           requiredRole: 'DevOps Engineer',     priority: 'high',     estimated_days: 1 },
  ],

  'ecommerce': [
    { title: 'Product catalogue planning',           requiredRole: 'Business Analyst',    priority: 'high',     estimated_days: 2 },
    { title: 'UI/UX for shop & checkout',            requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 5 },
    { title: 'Frontend development',                 requiredRole: 'Frontend Developer',  priority: 'high',     estimated_days: 10 },
    { title: 'Payment gateway integration',          requiredRole: 'Backend Developer',   priority: 'critical', estimated_days: 5 },
    { title: 'Inventory & order management',         requiredRole: 'Backend Developer',   priority: 'high',     estimated_days: 5 },
    { title: 'Security & PCI compliance review',     requiredRole: 'QA Engineer',         priority: 'critical', estimated_days: 3 },
    { title: 'Performance testing',                  requiredRole: 'QA Engineer',         priority: 'high',     estimated_days: 2 },
    { title: 'Deployment & monitoring setup',        requiredRole: 'DevOps Engineer',     priority: 'high',     estimated_days: 2 },
  ],

  'data_analytics': [
    { title: 'Data source identification & access',  requiredRole: 'Data Analyst',        priority: 'high',     estimated_days: 3 },
    { title: 'Data pipeline / ETL development',      requiredRole: 'Data Engineer',       priority: 'high',     estimated_days: 7 },
    { title: 'Dashboard design',                     requiredRole: 'UI Designer',         priority: 'medium',   estimated_days: 3 },
    { title: 'Dashboard development',                requiredRole: 'Frontend Developer',  priority: 'medium',   estimated_days: 5 },
    { title: 'Data validation & QA',                 requiredRole: 'QA Engineer',         priority: 'high',     estimated_days: 3 },
    { title: 'Stakeholder demo & sign-off',          requiredRole: 'Data Analyst',        priority: 'medium',   estimated_days: 1 },
  ],

  'design': [
    { title: 'Brand discovery session',              requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 1 },
    { title: 'Mood board & concept creation',        requiredRole: 'UI Designer',         priority: 'medium',   estimated_days: 2 },
    { title: 'Logo & identity design',               requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 5 },
    { title: 'Marketing collateral design',          requiredRole: 'UI Designer',         priority: 'medium',   estimated_days: 5 },
    { title: 'Client review & revisions',            requiredRole: 'UI Designer',         priority: 'medium',   estimated_days: 3 },
    { title: 'Final asset delivery',                 requiredRole: 'UI Designer',         priority: 'high',     estimated_days: 1 },
  ],

  'api_service': [
    { title: 'API specification (OpenAPI/Swagger)',  requiredRole: 'Backend Developer',   priority: 'high',     estimated_days: 2 },
    { title: 'Database schema design',               requiredRole: 'Backend Developer',   priority: 'high',     estimated_days: 2 },
    { title: 'Core API development',                 requiredRole: 'Backend Developer',   priority: 'high',     estimated_days: 10 },
    { title: 'Authentication & authorisation',       requiredRole: 'Backend Developer',   priority: 'critical', estimated_days: 3 },
    { title: 'API documentation',                    requiredRole: 'Backend Developer',   priority: 'medium',   estimated_days: 2 },
    { title: 'Integration & load testing',           requiredRole: 'QA Engineer',         priority: 'high',     estimated_days: 3 },
    { title: 'Deployment & versioning',              requiredRole: 'DevOps Engineer',     priority: 'high',     estimated_days: 2 },
  ],

  // Default fallback used when projectType doesn't match any key above
  'other': [
    { title: 'Project kick-off & planning',          requiredRole: null,                  priority: 'high',     estimated_days: 2 },
    { title: 'Execution phase',                      requiredRole: null,                  priority: 'medium',   estimated_days: 10 },
    { title: 'Review & QA',                          requiredRole: null,                  priority: 'medium',   estimated_days: 3 },
    { title: 'Delivery & sign-off',                  requiredRole: null,                  priority: 'high',     estimated_days: 1 },
  ],
};

// ─── Role → designation fuzzy matcher ─────────────────────────────────────────

/**
 * Find the best-matching active employee for a required role.
 * Checks designation field first, then department (case-insensitive contains match).
 * Returns null if no match found.
 */
async function findUserByRole(requiredRole) {
  if (!requiredRole) return null;

  const lowerRole = requiredRole.toLowerCase();

  // 1. Try exact / partial designation match among active employees
  const byDesignation = await User.findOne({
    role:   'employee',
    status: 'active',
    designation: { $regex: lowerRole, $options: 'i' },
  }).select('_id name designation');

  if (byDesignation) return byDesignation;

  // 2. Fallback: department contains the keyword
  const byDepartment = await User.findOne({
    role:   'employee',
    status: 'active',
    department: { $regex: lowerRole, $options: 'i' },
  }).select('_id name designation');

  return byDepartment || null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * autoCreateTasksForProject(project, createdByUserId)
 *
 * Selects the correct task template set for `project.project_type`,
 * creates Task documents, and assigns employees by role.
 *
 * This function is designed to be fire-and-forget (non-blocking).
 * Any error is logged but does NOT crash the caller.
 *
 * @param {Object} project         — Mongoose Project document
 * @param {string} createdByUserId — _id of the admin/manager who created the project
 */
async function autoCreateTasksForProject(project, createdByUserId) {
  try {
    const type = (project.project_type || 'other').trim();

    // ── 1. MANUAL TEMPLATE FIRST ────────────────────────────────────────────
    // If an admin has defined an active TaskTemplate for this project type,
    // it FULLY REPLACES the built-in auto generation for this project.
    const manualCreated = await createTasksFromDbTemplate(project, type, createdByUserId);
    if (manualCreated !== null) {
      // A matching template existed (manualCreated = number of tasks created).
      // Do NOT fall through to the hardcoded PROJECT_TASK_TEMPLATES.
      return;
    }

    // ── 2. FALLBACK: built-in hardcoded templates (unchanged) ───────────────
    const templates = PROJECT_TASK_TEMPLATES[type] || PROJECT_TASK_TEMPLATES['other'];

    const startDate = project.start_date ? new Date(project.start_date) : new Date();
    let   cursor    = new Date(startDate);

    const taskDocs = [];

    for (const tpl of templates) {
      // Avoid creating duplicates (e.g., if project was already seeded)
      const exists = await Task.exists({
        project_id: project._id,
        title:      tpl.title,
        is_auto_assigned: true,
      });
      if (exists) continue;

      const dueDate = new Date(cursor);
      dueDate.setDate(dueDate.getDate() + (tpl.estimated_days || 1));

      const assignedUser = await findUserByRole(tpl.requiredRole);

      const taskDoc = {
        project_id:         project._id,
        title:              tpl.title,
        description:        `Auto-generated task for ${type} project: ${project.title}`,
        assigned_to:        assignedUser ? assignedUser._id : null,
        assigned_by:        createdByUserId || null,
        required_role:      tpl.requiredRole || null,
        priority:           tpl.priority || 'medium',
        status:             assignedUser ? 'todo' : 'unassigned',
        is_auto_assigned:   true,
        auto_assign_reason: assignedUser
          ? `Matched by role: ${tpl.requiredRole}`
          : 'No matching employee found — manual assignment needed',
        start_date:       new Date(cursor),
        end_date:         new Date(dueDate),
        due_date:         new Date(dueDate),
        estimated_days:   tpl.estimated_days || 1,
        module_name:      type,
      };

      taskDocs.push(taskDoc);

      // Advance cursor for sequential scheduling
      cursor = new Date(dueDate);
    }

    if (taskDocs.length > 0) {
      await Task.insertMany(taskDocs, { ordered: false });
      console.log(
        `[taskService] Created ${taskDocs.length} auto-tasks for project "${project.title}" (type: ${type})`
      );
    }
  } catch (error) {
    console.error(`[taskService] autoCreateTasksForProject failed for project ${project._id}:`, error.message);
  }
}

/**
 * createTasksFromDbTemplate(project, type, createdByUserId)
 *
 * Looks up an active, admin-defined TaskTemplate matching `type`. If found,
 * creates one Task per template task (carrying its subtasks) and returns the
 * number created. If NO matching template exists, returns `null` so the caller
 * can fall back to the built-in generator.
 *
 * Matching is slug-based: the template's projectType is already stored as a
 * normalised slug, so we normalise the project type the same way and compare.
 *
 * @returns {Promise<number|null>}  count created, or null if no template
 */
async function createTasksFromDbTemplate(project, type, createdByUserId) {
  const slug = String(type).toLowerCase().trim().replace(/[\s\-]+/g, '_');

  // Exact slug match on an active template.
  const template = await TaskTemplate.findOne({ projectType: slug, isActive: true });
  if (!template || !Array.isArray(template.tasks) || template.tasks.length === 0) {
    // template exists but empty → treat as "no usable template" and fall back
    if (template && (!template.tasks || template.tasks.length === 0)) return null;
    if (!template) return null;
  }

  const startDate = project.start_date ? new Date(project.start_date) : new Date();
  let   cursor    = new Date(startDate);

  const taskDocs = [];

  for (const t of template.tasks) {
    // Skip if an identically-titled auto task already exists for this project.
    const exists = await Task.exists({
      project_id: project._id,
      title:      t.name,
      is_auto_assigned: true,
    });
    if (exists) continue;

    const estHours = Number(t.estimatedHours) > 0 ? Number(t.estimatedHours) : 8;
    const estDays  = Math.max(1, Math.ceil(estHours / 8));

    const dueDate = new Date(cursor);
    dueDate.setDate(dueDate.getDate() + estDays);

    // Role for auto-assignment: prefer designation, fall back to department.
    const requiredRole = t.designation || t.department || null;
    const assignedUser = await findUserByRole(requiredRole);

    taskDocs.push({
      project_id:  project._id,
      title:       t.name,
      description: t.description || `Task from "${template.name}" template: ${project.title}`,
      assigned_to: assignedUser ? assignedUser._id : null,
      assigned_by: createdByUserId || null,
      required_role:       requiredRole,
      required_department: t.department || null,
      priority:    ['low', 'medium', 'high', 'critical'].includes(t.priority) ? t.priority : 'medium',
      status:      assignedUser ? 'todo' : 'unassigned',
      is_auto_assigned:   true,
      auto_assign_reason: assignedUser
        ? `Matched by role: ${requiredRole}`
        : (requiredRole
            ? 'No matching employee found — manual assignment needed'
            : 'No role specified in template — manual assignment needed'),
      start_date:      new Date(cursor),
      end_date:        new Date(dueDate),
      due_date:        new Date(dueDate),
      estimated_days:  estDays,
      estimated_hours: estHours,
      module_name:     template.name,
      // Subtasks carried straight from the template.
      subtasks: (t.subtasks || [])
        .filter((s) => s && String(s.name || '').trim() !== '')
        .map((s) => ({ title: String(s.name).trim(), status: 'todo' })),
    });

    cursor = new Date(dueDate);
  }

  if (taskDocs.length > 0) {
    await Task.insertMany(taskDocs, { ordered: false });
    console.log(
      `[taskService] Created ${taskDocs.length} tasks from manual template "${template.name}" for project "${project.title}" (type: ${slug})`
    );
  } else {
    console.log(
      `[taskService] Manual template "${template.name}" matched project "${project.title}" but all tasks already existed.`
    );
  }

  // Return a number (even 0) to signal "template handled this project".
  return taskDocs.length;
}

module.exports = { autoCreateTasksForProject };