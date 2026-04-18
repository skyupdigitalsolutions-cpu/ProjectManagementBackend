/**
 * autoAssignService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Smart task auto-assignment engine.
 *
 * Responsibilities:
 *  1. Map project_type → required departments/roles
 *  2. Score each candidate employee by workload + priority (across ALL projects)
 *  3. When a NEW project is added → factor in existing task load before assigning
 *  4. Detect leave conflicts and reassign to next best employee
 *  5. Handle permission flags
 *  6. Emit notifications for every action
 *  7. Save start_date / end_date on every task (day-wise scheduling)
 */

const Task          = require("../models/tasks");
const User          = require("../models/users");
const Leave         = require("../models/leave");
const Notification  = require("../models/notification");
const ProjectMember = require("../models/project_member");
const { scheduleTasksWithWorkload, getUserRoleEndDates } = require("./schedulingEngine");

// ─── Project type → department role mapping ──────────────────────────────────
const PROJECT_TYPE_ROLES = {
  website: [
    { role: "frontend developer",   department: "Web Development", priority_order: 1 },
    { role: "backend developer",    department: "Web Development", priority_order: 2 },
    { role: "full stack developer", department: "Web Development", priority_order: 3 },
    { role: "designer",             department: "Design",          priority_order: 4 },
  ],
  mobile_app: [
    { role: "mobile developer",     department: "Mobile",          priority_order: 1 },
    { role: "backend developer",    department: "Web Development", priority_order: 2 },
    { role: "designer",             department: "Design",          priority_order: 3 },
  ],
  ecommerce: [
    { role: "full stack developer", department: "Web Development", priority_order: 1 },
    { role: "backend developer",    department: "Web Development", priority_order: 2 },
    { role: "seo specialist",       department: "SEO",             priority_order: 3 },
    { role: "designer",             department: "Design",          priority_order: 4 },
  ],
  api_service: [
    { role: "backend developer",    department: "Web Development", priority_order: 1 },
    { role: "full stack developer", department: "Web Development", priority_order: 2 },
  ],
  data_analytics: [
    { role: "data analyst",         department: "Analytics",       priority_order: 1 },
    { role: "backend developer",    department: "Web Development", priority_order: 2 },
  ],
  design: [
    { role: "designer",             department: "Design",          priority_order: 1 },
  ],
  content: [
    { role: "content writer",       department: "Content Writing", priority_order: 1 },
  ],
  seo: [
    { role: "seo specialist",       department: "SEO",             priority_order: 1 },
    { role: "content writer",       department: "Content Writing", priority_order: 2 },
  ],
  marketing: [
    { role: "marketing specialist", department: "Social Media",    priority_order: 1 },
    { role: "content writer",       department: "Content Writing", priority_order: 2 },
  ],
};

// Priority → numeric score (higher = more urgent)
const PRIORITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };

// Max workload score before a user is considered "overloaded"
const MAX_WORKLOAD_SCORE = 300;

// ─── Workload ────────────────────────────────────────────────────────────────

/**
 * Calculate a user's total workload score across ALL active tasks (all projects).
 * Lower score = less loaded = better candidate for new assignment.
 */
async function getUserWorkloadScore(userId) {
  const tasks = await Task.find({
    assigned_to: userId,
    status: { $in: ["todo", "in-progress", "on-hold"] },
  }).select("priority");

  return tasks.reduce((score, t) => score + (PRIORITY_SCORE[t.priority] || 0), 0);
}

/**
 * Count how many active projects a user is already assigned to.
 * Used to prevent one person from being overloaded with new projects.
 */
async function getUserActiveProjectCount(userId) {
  const tasks = await Task.distinct("project_id", {
    assigned_to: userId,
    status: { $in: ["todo", "in-progress", "on-hold"] },
  });
  return tasks.length;
}

// ─── Leave ───────────────────────────────────────────────────────────────────

/**
 * Check if a user is on approved leave on a given date.
 */
async function isUserOnLeave(userId, date = new Date()) {
  const leave = await Leave.findOne({
    user_id:   userId,
    status:    "approved",
    from_date: { $lte: date },
    to_date:   { $gte: date },
  });
  return !!leave;
}

// ─── Candidate picking ───────────────────────────────────────────────────────

/**
 * Find the best available employee for a given role/department.
 *
 * Scoring factors (in priority order):
 *  1. Not on leave today
 *  2. Lowest workload score (fewest / lightest active tasks across all projects)
 *  3. Fewest active projects (tie-breaker)
 *
 * @param {Object[]} candidateUsers   - Array of User docs
 * @param {Date}     taskStartDate    - When the task will start (for leave check)
 * @param {string[]} excludeUserIds   - Skip these IDs (already assigned in this batch)
 * @returns {Object|null} Best user doc, or null if none found
 */
async function pickBestCandidate(candidateUsers, taskStartDate, excludeUserIds = []) {
  const checkDate = taskStartDate ? new Date(taskStartDate) : new Date();

  const scored = await Promise.all(
    candidateUsers
      .filter((u) => !excludeUserIds.includes(u._id.toString()) && u.status === "active")
      .map(async (u) => {
        const onLeave      = await isUserOnLeave(u._id, checkDate);
        const workload     = await getUserWorkloadScore(u._id);
        const projectCount = await getUserActiveProjectCount(u._id);
        return { user: u, onLeave, workload, projectCount };
      })
  );

  // Prefer: not on leave → lowest workload → fewest projects
  const available = scored
    .filter((s) => !s.onLeave)
    .sort((a, b) => a.workload - b.workload || a.projectCount - b.projectCount);

  if (available.length) return available[0].user;

  // All on leave — fall back to lowest workload (flagged in notification)
  const fallback = scored.sort((a, b) => a.workload - b.workload);
  return fallback.length ? fallback[0].user : null;
}

// ─── Main auto-assign function ───────────────────────────────────────────────

/**
 * Auto-assign tasks for a project, with full workload awareness across all projects.
 *
 * KEY BEHAVIOUR for new projects:
 *  - Checks each candidate's existing task schedule (end_dates) before assigning
 *  - Uses scheduleTasksWithWorkload() so new tasks start AFTER the user's existing work
 *  - This means no user is double-booked or overloaded when a new project lands
 *
 * @param {Object}   project       - Mongoose Project doc
 * @param {Object[]} taskDrafts    - Task drafts (already have start_date/end_date from schedulingEngine,
 *                                   OR just have required_role + estimated_days for re-scheduling here)
 * @param {string}   assignedById  - ObjectId string of admin/manager triggering this
 * @returns {Object[]} Created Task documents
 */
async function autoAssignProjectTasks(project, taskDrafts, assignedById) {
  // Group drafts by required_role so we can assign per-role
  const createdTasks = [];

  // Track which users we've already assigned in this batch
  // (allows the same user to get multiple tasks, but prefers distributing)
  const assignmentCount = {}; // userId → number of tasks assigned this run

  for (const draft of taskDrafts) {
    const neededRole = draft.required_role || null;
    const neededDept = draft.required_department || null;

    // ── Build candidate pool ─────────────────────────────────────────────
    // First check project members (preferred), then fall back to all active users
    const projectMembers = await ProjectMember.find({
      project_id: project._id,
      status: "active",
    }).populate("user_id");

    let pool = projectMembers.map((pm) => pm.user_id).filter(Boolean);

    if (neededRole && pool.length) {
      pool = pool.filter(
        (u) =>
          u.designation?.toLowerCase().includes(neededRole.toLowerCase()) ||
          u.department?.toLowerCase().includes(neededRole.toLowerCase())
      );
    } else if (neededDept && pool.length) {
      pool = pool.filter((u) =>
        u.department?.toLowerCase().includes(neededDept.toLowerCase())
      );
    }

    // No matching project members → search ALL active users by role/dept
    if (!pool.length) {
      const query = { status: "active", role: "employee" };
      if (neededRole) query.designation = { $regex: neededRole, $options: "i" };
      else if (neededDept) query.department = { $regex: neededDept, $options: "i" };
      pool = await User.find(query);
    }

    // Still no one → skip this task
    if (!pool.length) continue;

    // ── Pick best candidate ──────────────────────────────────────────────
    // Sort pool by: least tasks assigned this run first, then by workload
    pool.sort((a, b) => {
      const countA = assignmentCount[a._id.toString()] || 0;
      const countB = assignmentCount[b._id.toString()] || 0;
      return countA - countB;
    });

    const assignee = await pickBestCandidate(pool, draft.start_date || new Date(), []);
    if (!assignee) continue;

    // ── If this draft has no start/end dates, schedule around assignee's workload ──
    let taskStart = draft.start_date;
    let taskEnd   = draft.end_date;
    let taskDue   = draft.due_date;

    if (!taskStart) {
      // Get the latest end_date this user already has for this role
      const existingTasks = await Task.find({
        assigned_to:   assignee._id,
        required_role: neededRole,
        status: { $in: ["todo", "in-progress", "on-hold"] },
      }).select("end_date required_role");

      const existingWorkload = getUserRoleEndDates(existingTasks);

      const [rescheduled] = scheduleTasksWithWorkload(
        [draft],
        project.start_date,
        existingWorkload
      );
      taskStart = rescheduled.start_date;
      taskEnd   = rescheduled.end_date;
      taskDue   = rescheduled.due_date;
    }

    // ── Create the task ──────────────────────────────────────────────────
    const isOnLeave       = await isUserOnLeave(assignee._id);
    const projectBonus    = project.priority === "critical" ? 30 : project.priority === "high" ? 15 : 0;
    const priorityScore   = (PRIORITY_SCORE[draft.priority || "medium"] || 50) + projectBonus;
    const requiresPermission = draft.requires_permission || false;
    const permStatus      = requiresPermission ? "pending" : "not_required";

    const task = await Task.create({
      project_id:             project._id,
      assignment_id:          draft.assignment_id || null,
      title:                  draft.title,
      description:            draft.description || null,
      module_name:            draft.module_name || null,
      assigned_to:            assignee._id,
      assigned_by:            assignedById,
      status:                 requiresPermission ? "blocked" : "todo",
      priority:               draft.priority || "medium",
      priority_score:         priorityScore,
      start_date:             taskStart,
      end_date:               taskEnd,
      due_date:               taskDue || taskEnd,
      estimated_days:         draft.estimated_days || 1,
      estimated_hours:        draft.estimated_hours || null,
      is_auto_assigned:       true,
      auto_assign_reason:     `Auto-assigned: project_type="${project.project_type}", role="${neededRole || neededDept || "any"}"`,
      requires_permission:    requiresPermission,
      permission_description: draft.permission_description || null,
      permission_status:      permStatus,
      required_role:          neededRole,
      required_department:    neededDept,
    });

    createdTasks.push(task);

    // Track how many tasks this user was assigned in this run
    const uid = assignee._id.toString();
    assignmentCount[uid] = (assignmentCount[uid] || 0) + 1;

    // Auto-add assignee as a project member if not already
    await ProjectMember.findOneAndUpdate(
      { project_id: project._id, user_id: assignee._id },
      { project_id: project._id, user_id: assignee._id, role_in_project: "developer" },
      { upsert: true, new: true }
    ).catch(() => {}); // ignore duplicate key errors

    // ── Notifications ────────────────────────────────────────────────────
    await Notification.create({
      user_id:   assignee._id,
      sender_id: assignedById,
      message:   `[Auto-Assigned] Task "${task.title}" assigned to you. Starts: ${taskStart ? new Date(taskStart).toDateString() : "TBD"}, Due: ${taskEnd ? new Date(taskEnd).toDateString() : "TBD"}.`,
      type:      "auto_assign",
      ref_id:    task._id,
      ref_type:  "Task",
    }).catch(console.error);

    if (isOnLeave) {
      await Notification.create({
        user_id:   assignedById,
        sender_id: null,
        message:   `⚠️ "${assignee.name}" is currently on leave but was auto-assigned task "${task.title}". Consider reassigning.`,
        type:      "leave_cover_assigned",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }

    if (requiresPermission) {
      await Notification.create({
        user_id:   assignedById,
        sender_id: null,
        message:   `🔐 Task "${task.title}" requires admin permission before work can start.`,
        type:      "permission_requested",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }
  }

  return createdTasks;
}

// ─── Leave reassignment ───────────────────────────────────────────────────────

/**
 * Reassign all open high/critical tasks of an employee going on leave.
 * Picks the next best available person and preserves the original schedule.
 */
async function handleLeaveReassignment(leavingUserId, leaveFrom, leaveTo, adminId) {
  const urgentTasks = await Task.find({
    assigned_to: leavingUserId,
    status:      { $in: ["todo", "in-progress"] },
    priority:    { $in: ["high", "critical"] },
    due_date:    { $gte: leaveFrom, $lte: leaveTo },
  });

  const reassignedTasks = [];

  for (const task of urgentTasks) {
    const projectMembers = await ProjectMember.find({
      project_id: task.project_id,
      status:     "active",
      user_id:    { $ne: leavingUserId },
    }).populate("user_id");

    let pool = projectMembers.map((pm) => pm.user_id).filter(Boolean);

    if (task.required_role) {
      pool = pool.filter((u) =>
        u.designation?.toLowerCase().includes(task.required_role.toLowerCase())
      );
    }

    if (!pool.length) {
      const query = { status: "active", _id: { $ne: leavingUserId } };
      if (task.required_role) query.designation = { $regex: task.required_role, $options: "i" };
      pool = await User.find(query);
    }

    const newAssignee = await pickBestCandidate(pool, task.start_date || task.due_date);
    if (!newAssignee) continue;

    task.reassign_logs.push({
      from_user:     leavingUserId,
      to_user:       newAssignee._id,
      reason:        `Employee on leave from ${leaveFrom.toDateString()} to ${leaveTo.toDateString()}`,
      reassigned_by: adminId || null,
      trigger:       "leave_cover",
    });
    task.assigned_to = newAssignee._id;
    await task.save();
    reassignedTasks.push(task);

    await Notification.create({
      user_id:   newAssignee._id,
      sender_id: adminId || null,
      message:   `📋 Task "${task.title}" reassigned to you — original assignee is on leave.`,
      type:      "task_reassigned",
      ref_id:    task._id,
      ref_type:  "Task",
    }).catch(console.error);

    await Notification.create({
      user_id:   adminId,
      sender_id: null,
      message:   `✅ Task "${task.title}" auto-reassigned to "${newAssignee.name}" due to leave.`,
      type:      "leave_cover_assigned",
      ref_id:    task._id,
      ref_type:  "Task",
    }).catch(console.error);
  }

  return reassignedTasks;
}

// ─── Workload rebalancing ─────────────────────────────────────────────────────

/**
 * If a user is overloaded (score > maxWorkloadScore), redistribute their
 * lowest-priority todo tasks to other project members.
 */
async function rebalanceTasks(userId, projectId, maxWorkloadScore = MAX_WORKLOAD_SCORE, adminId) {
  const currentScore = await getUserWorkloadScore(userId);
  if (currentScore <= maxWorkloadScore) return [];

  const overflowTasks = await Task.find({
    assigned_to: userId,
    project_id:  projectId,
    status:      { $in: ["todo"] },
    priority:    { $in: ["low", "medium"] },
  }).sort({ priority_score: 1 }).limit(3);

  const reassigned = [];

  for (const task of overflowTasks) {
    const projectMembers = await ProjectMember.find({
      project_id: projectId,
      status:     "active",
      user_id:    { $ne: userId },
    }).populate("user_id");

    const pool = projectMembers.map((pm) => pm.user_id).filter(Boolean);
    const newAssignee = await pickBestCandidate(pool, task.start_date || task.due_date);
    if (!newAssignee) continue;

    task.reassign_logs.push({
      from_user:     userId,
      to_user:       newAssignee._id,
      reason:        "Workload rebalancing — original assignee has too many active tasks",
      reassigned_by: adminId || null,
      trigger:       "priority_rebalance",
    });
    task.assigned_to = newAssignee._id;
    await task.save();
    reassigned.push(task);

    await Notification.create({
      user_id:   newAssignee._id,
      sender_id: adminId || null,
      message:   `📋 Task "${task.title}" reassigned to you due to workload rebalancing.`,
      type:      "task_reassigned",
      ref_id:    task._id,
      ref_type:  "Task",
    }).catch(console.error);
  }

  return reassigned;
}

module.exports = {
  autoAssignProjectTasks,
  handleLeaveReassignment,
  rebalanceTasks,
  pickBestCandidate,
  isUserOnLeave,
  getUserWorkloadScore,
  getUserActiveProjectCount,
  PROJECT_TYPE_ROLES,
  PRIORITY_SCORE,
  MAX_WORKLOAD_SCORE,
};
