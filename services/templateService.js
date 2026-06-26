/**
 * services/templateService.js
 *
 * Pure business-logic layer for the template-based project planning system.
 * No Express req/res here — controllers call these functions.
 *
 * Public API:
 *   getTemplateByProjectType(projectType)          → TaskTemplate doc | null
 *   generateTasksFromTemplate(template, projectType)→ task[]
 *   normalizeTasks(tasks)                          → task[]
 *   mergeTasks(templateTasks, excelTasks)          → task[]
 *   parseExcelToTasks(filePath)                    → task[]
 */

const TaskTemplate = require('../models/TaskTemplate');
const { parseExcelFile } = require('./excelParserService');

// ─── 1. FETCH TEMPLATE BY PROJECT TYPE ───────────────────────────────────────

/**
 * Returns the active TaskTemplate document whose projectType slug matches
 * the supplied value (case-insensitive, spaces→underscores normalised).
 *
 * @param {string} projectType  e.g. "Web App" | "web_app" | "website"
 * @returns {Promise<import('../models/TaskTemplate')|null>}
 */
async function getTemplateByProjectType(projectType) {
  if (!projectType) return null;

  // Normalise: lowercase + replace spaces/hyphens with underscore
  const slug = projectType
    .toLowerCase()
    .trim()
    .replace(/[\s\-]+/g, '_');

  // Try exact slug match first
  let template = await TaskTemplate.findOne({ projectType: slug, isActive: true });

  // Fallback: partial / contains match  (e.g. "web" matches "web_app")
  if (!template) {
    template = await TaskTemplate.findOne({
      projectType: { $regex: slug, $options: 'i' },
      isActive: true,
    });
  }

  return template;
}

// ─── 2. GENERATE TASKS FROM TEMPLATE ─────────────────────────────────────────

/**
 * Converts a TaskTemplate document into an array of normalised task objects
 * ready for preview or DB insertion.
 *
 * @param {object} template      TaskTemplate mongoose document or plain object
 * @param {string} [projectType] Optional override label stored in source metadata
 * @returns {object[]}
 */
function generateTasksFromTemplate(template, projectType = '') {
  if (!template || !Array.isArray(template.tasks)) return [];

  return template.tasks.map((t, index) => ({
    // Identity
    _templateTaskId: t._id?.toString() ?? `tmpl-${index}`,
    title:           t.name,
    description:     t.description ?? null,

    // Workforce metadata (used for auto-assignment)
    required_role:       t.designation  ?? null,
    required_department: t.department   ?? null,

    // Time
    estimated_hours: t.estimatedHours ?? 8,
    estimated_days:  Math.ceil((t.estimatedHours ?? 8) / 8),

    // State — always pending on generation
    status:   'pending',
    priority: t.priority ?? 'medium',

    // Subtasks as proper objects
    subtasks: (t.subtasks ?? []).map(s => ({
      title:  s.name,
      status: 'todo',
    })),

    // Source tracking
    source:      'template',
    projectType: projectType || template.projectType,
  }));
}

// ─── 3. PARSE EXCEL FILE TO TASKS ────────────────────────────────────────────

/**
 * Reads an uploaded Excel file (via excelParserService) and converts every
 * non-blank row into a task object tagged source:"excel".
 *
 * Column aliases supported (case-insensitive, spaces→underscores):
 *   Task / Title / task_title
 *   Subtask / Sub Task
 *   Role / Required Role / designation
 *   Department / Dept
 *   Priority
 *   Duration (days) / Estimated Hours / estimated_hours
 *   Description / Notes
 *   Module / Category
 *
 * @param {string} filePath   Absolute path to the .xlsx/.xls file
 * @returns {object[]}
 */
function parseExcelToTasks(filePath) {
  const { rows } = parseExcelFile(filePath);

  return rows
    .map((row, idx) => {
      // Helper: try multiple key aliases, return first truthy value
      const pick = (...keys) => {
        for (const k of keys) {
          const v = row[k] ?? row[k.toLowerCase()] ?? row[k.replace(/_/g, ' ')];
          if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return null;
      };

      const title = pick('task', 'Task', 'title', 'Title', 'task_title', 'TASK');
      if (!title) return null; // skip empty rows

      const rawPriority  = pick('priority', 'Priority', 'PRIORITY') ?? 'medium';
      const rawDuration  = pick('duration_(days)', 'Duration (days)', 'estimated_hours',
                                'Estimated Hours', 'duration', 'Duration') ?? '1';
      const subtaskName  = pick('subtask', 'Subtask', 'Sub Task', 'sub_task');

      return {
        title,
        description:         pick('description', 'Description', 'notes', 'Notes') ?? null,
        required_role:       pick('role', 'Role', 'required_role', 'designation', 'Designation') ?? null,
        required_department: pick('department', 'Department', 'dept', 'Dept') ?? null,
        priority:            normalisePriority(rawPriority),
        estimated_hours:     parseDurationToHours(rawDuration),
        estimated_days:      Math.ceil(parseDurationToHours(rawDuration) / 8),
        module_name:         pick('module', 'Module', 'category', 'Category') ?? null,
        status:              'pending',
        subtasks:            subtaskName ? [{ title: subtaskName, status: 'todo' }] : [],
        source:              'excel',
        _excelRowIndex:      idx + 2, // 1-based + header offset
      };
    })
    .filter(Boolean);
}

// ─── 4. MERGE TEMPLATE + EXCEL TASKS ─────────────────────────────────────────

/**
 * Combines templateTasks and excelTasks into a single deduplicated array.
 *
 * Merge rules:
 *  1. Template tasks come first (they define the base plan).
 *  2. If an Excel task has the same title (case-insensitive trim) as a
 *     template task, their subtasks are merged and the Excel description
 *     (if present) is appended as a note — no duplication.
 *  3. Net-new Excel tasks (no matching template task) are appended at the end.
 *  4. Both `source` values are preserved in a `sources` array on merged items.
 *
 * @param {object[]} templateTasks
 * @param {object[]} excelTasks
 * @returns {object[]}
 */
function mergeTasks(templateTasks = [], excelTasks = []) {
  // Index template tasks by normalised title for O(1) lookup
  const byTitle = new Map();
  const merged  = [];

  for (const t of templateTasks) {
    const key = normaliseTitle(t.title);
    byTitle.set(key, merged.length);
    merged.push({
      ...t,
      sources: [t.source ?? 'template'],
    });
  }

  for (const e of excelTasks) {
    const key = normaliseTitle(e.title);

    if (byTitle.has(key)) {
      // Merge into existing template task
      const idx     = byTitle.get(key);
      const existing = merged[idx];

      // Union subtasks (by title)
      const existSubTitles = new Set(
        (existing.subtasks ?? []).map(s => normaliseTitle(s.title))
      );
      for (const sub of e.subtasks ?? []) {
        if (!existSubTitles.has(normaliseTitle(sub.title))) {
          existing.subtasks.push(sub);
          existSubTitles.add(normaliseTitle(sub.title));
        }
      }

      // Append Excel description as an extra note if different
      if (e.description && e.description !== existing.description) {
        existing.description = existing.description
          ? `${existing.description}\n[Excel note] ${e.description}`
          : e.description;
      }

      // Upgrade priority if Excel specifies higher
      existing.priority = higherPriority(existing.priority, e.priority);

      // Mark as merged from both sources
      if (!existing.sources.includes('excel')) existing.sources.push('excel');
      existing.source = 'merged';

    } else {
      // Net-new Excel task — append
      byTitle.set(key, merged.length);
      merged.push({
        ...e,
        sources: ['excel'],
      });
    }
  }

  return merged;
}

// ─── 5. NORMALISE TASKS ───────────────────────────────────────────────────────

/**
 * Ensures every task in the array conforms to the standard structure.
 * Safe to call on any mix of template / Excel / merged tasks.
 *
 * @param {object[]} tasks
 * @returns {object[]}
 */
function normalizeTasks(tasks = []) {
  return tasks.map((t, idx) => ({
    // --- Required fields ---
    title:   String(t.title ?? 'Untitled Task').trim(),
    status:  VALID_STATUSES.includes(t.status) ? t.status : 'pending',
    priority: VALID_PRIORITIES.includes(t.priority) ? t.priority : 'medium',

    // --- Optional / derived ---
    description:         t.description         ?? null,
    required_role:       t.required_role        ?? null,
    required_department: t.required_department  ?? null,
    estimated_hours:     typeof t.estimated_hours === 'number' ? t.estimated_hours : 8,
    estimated_days:      typeof t.estimated_days  === 'number' ? t.estimated_days  : 1,
    module_name:         t.module_name          ?? null,

    // --- Subtasks must always be objects with at least { title, status } ---
    subtasks: (t.subtasks ?? []).map(s =>
      typeof s === 'string'
        ? { title: s, status: 'todo' }
        : { title: String(s.title ?? 'Subtask').trim(), status: s.status ?? 'todo' }
    ),

    // --- Source tracking ---
    source:      t.source   ?? 'manual',
    sources:     t.sources  ?? [t.source ?? 'manual'],
    projectType: t.projectType ?? null,

    // --- Position for ordered rendering ---
    _order: idx,

    // --- Pass-through IDs for reference ---
    _templateTaskId: t._templateTaskId ?? null,
    _excelRowIndex:  t._excelRowIndex  ?? null,
  }));
}

// ─── Private helpers ──────────────────────────────────────────────────────────

const VALID_STATUSES   = ['pending', 'todo', 'in-progress', 'completed', 'on-hold', 'cancelled', 'blocked'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const PRIORITY_RANK    = { low: 0, medium: 1, high: 2, critical: 3 };

function normalisePriority(raw) {
  if (!raw) return 'medium';
  const v = String(raw).toLowerCase().trim();
  if (VALID_PRIORITIES.includes(v)) return v;
  if (v === 'urgent' || v === 'highest') return 'critical';
  if (v === 'normal')                    return 'medium';
  if (v === 'minor'  || v === 'lowest')  return 'low';
  return 'medium';
}

function higherPriority(a, b) {
  return (PRIORITY_RANK[b] ?? 1) > (PRIORITY_RANK[a] ?? 1) ? b : a;
}

function normaliseTitle(title) {
  return String(title ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function parseDurationToHours(raw) {
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  if (isNaN(n)) return 8;
  // Heuristic: values > 24 are already in hours; ≤24 treated as days
  return n > 24 ? n : n * 8;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getTemplateByProjectType,
  generateTasksFromTemplate,
  parseExcelToTasks,
  mergeTasks,
  normalizeTasks,
};