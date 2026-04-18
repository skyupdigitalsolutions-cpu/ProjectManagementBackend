/**
 * autoAssignService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Smart task auto-assignment engine.
 *
 * Responsibilities:
 *  1. Map project_type → required departments/roles
 *  2. Score each candidate employee by workload + priority
 *  3. Detect leave conflicts and reassign to next best employee
 *  4. Handle permission flags
 *  5. Emit notifications for every action
 */

const Task         = require("../models/tasks");
const User         = require("../models/users");
const Leave        = require("../models/leave");
const Notification = require("../models/notification");
const ProjectMember = require("../models/project_member");

// ─── Project type → department role mapping ─────────────────────────────────
const PROJECT_TYPE_ROLES = {
  website: [
    { role: "frontend developer", department: "Web Development", priority_order: 1 },
    { role: "backend developer",  department: "Web Development", priority_order: 2 },
    { role: "full stack developer", department: "Web Development", priority_order: 3 },
    { role: "designer",           department: "Design",          priority_order: 4 },
  ],
  mobile_app: [
    { role: "mobile developer",   department: "Mobile",          priority_order: 1 },
    { role: "backend developer",  department: "Web Development", priority_order: 2 },
    { role: "designer",           department: "Design",          priority_order: 3 },
  ],
  ecommerce: [
    { role: "full stack developer", department: "Web Development", priority_order: 1 },
    { role: "backend developer",  department: "Web Development", priority_order: 2 },
    { role: "seo specialist",     department: "SEO",             priority_order: 3 },
    { role: "designer",           department: "Design",          priority_order: 4 },
  ],
  api_service: [
    { role: "backend developer",  department: "Web Development", priority_order: 1 },
    { role: "full stack developer", department: "Web Development", priority_order: 2 },
  ],
  data_analytics: [
    { role: "data analyst",       department: "Analytics",       priority_order: 1 },
    { role: "backend developer",  department: "Web Development", priority_order: 2 },
  ],
  design: [
    { role: "designer",           department: "Design",          priority_order: 1 },
  ],
  content: [
    { role: "content writer",     department: "Content Writing", priority_order: 1 },
  ],
  seo: [
    { role: "seo specialist",     department: "SEO",             priority_order: 1 },
    { role: "content writer",     department: "Content Writing", priority_order: 2 },
  ],
  marketing: [
    { role: "marketing specialist", department: "Social Media",  priority_order: 1 },
    { role: "content writer",     department: "Content Writing", priority_order: 2 },
  ],
};

// Priority → numeric score (higher = more urgent)
const PRIORITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };

/**
 * Calculate how many active/high-priority tasks a user currently holds.
 * Lower score = less loaded = better candidate.
 */
async function getUserWorkloadScore(userId) {
  const tasks = await Task.find({
    assigned_to: userId,
    status: { $in: ["todo", "in-progress", "on-hold"] },
  }).select("priority");

  return tasks.reduce((score, t) => score + (PRIORITY_SCORE[t.priority] || 0), 0);
}

/**
 * Check if a user is on approved leave on a given date.
 */
async function isUserOnLeave(userId, date = new Date()) {
  const leave = await Leave.findOne({
    user_id: userId,
    status:  "approved",
    from_date: { $lte: date },
    to_date:   { $gte: date },
  });
  return !!leave;
}

/**
 * Find the best available employee for a given role/department from a pool.
 * Returns null if no one is available.
 *
 * @param {Object[]} candidateUsers  - Array of User docs
 * @param {Date}     dueDate         - Task due date (for leave check)
 * @param {string[]} excludeUserIds  - Skip these (already assigned to other roles)
 */
async function pickBestCandidate(candidateUsers, dueDate, excludeUserIds = []) {
  const today = new Date();

  const scored = await Promise.all(
    candidateUsers
      .filter((u) => !excludeUserIds.includes(u._id.toString()) && u.status === "active")
      .map(async (u) => {
        const onLeave = await isUserOnLeave(u._id, today);
        const workload = await getUserWorkloadScore(u._id);
        return { user: u, onLeave, workload };
      })
  );

  // Prefer not-on-leave, then lowest workload
  const available = scored.filter((s) => !s.onLeave).sort((a, b) => a.workload - b.workload);
  if (available.length) return available[0].user;

  // All on leave — fall back to lowest workload (will be flagged for leave-cover)
  const fallback = scored.sort((a, b) => a.workload - b.workload);
  return fallback.length ? fallback[0].user : null;
}

/**
 * Auto-assign tasks for a project based on its type.
 *
 * @param {Object}   project      - Mongoose Project doc
 * @param {Object[]} taskDrafts   - Array of task field objects (title, description, priority, due_date, etc.)
 * @param {string}   assignedById - ObjectId string of admin/manager triggering this
 * @returns {Object[]} created Task documents
 */
async function autoAssignProjectTasks(project, taskDrafts, assignedById) {
  const roleMap = PROJECT_TYPE_ROLES[project.project_type] || PROJECT_TYPE_ROLES.website;

  // Fetch all active project members
  const projectMembers = await ProjectMember.find({
    project_id: project._id,
    status: "active",
  }).populate("user_id");

  const members = projectMembers.map((pm) => pm.user_id).filter(Boolean);

  const createdTasks = [];
  const usedInThisRound = [];

  for (const draft of taskDrafts) {
    // Determine which role this task needs
    const neededRole = draft.required_role || null;
    const neededDept = draft.required_department || null;

    // Filter pool: match by role/department if specified, else use all members
    let pool = members;
    if (neededRole) {
      pool = members.filter(
        (u) =>
          u.designation?.toLowerCase().includes(neededRole.toLowerCase()) ||
          u.department?.toLowerCase().includes(neededRole.toLowerCase())
      );
    } else if (neededDept) {
      pool = members.filter((u) =>
        u.department?.toLowerCase().includes(neededDept.toLowerCase())
      );
    }

    // If no matching members found in project, broaden to all active users of that role
    if (!pool.length && (neededRole || neededDept)) {
      const query = { status: "active" };
      if (neededRole) query.designation = { $regex: neededRole, $options: "i" };
      else if (neededDept) query.department = { $regex: neededDept, $options: "i" };
      pool = await User.find(query);
    }

    const assignee = await pickBestCandidate(pool, draft.due_date, usedInThisRound);

    if (!assignee) continue; // skip if no candidate found

    const isOnLeave = await isUserOnLeave(assignee._id);
    const priorityScore =
      PRIORITY_SCORE[draft.priority || "medium"] +
      (project.priority === "critical" ? 30 : project.priority === "high" ? 15 : 0);

    // Determine if task needs permission
    const requiresPermission = draft.requires_permission || false;
    const permStatus = requiresPermission ? "pending" : "not_required";

    const task = await Task.create({
      project_id:             project._id,
      assignment_id:          draft.assignment_id || null,
      title:                  draft.title,
      description:            draft.description || null,
      assigned_to:            assignee._id,
      assigned_by:            assignedById,
      status:                 requiresPermission ? "blocked" : "todo",
      priority:               draft.priority || "medium",
      priority_score:         priorityScore,
      due_date:               draft.due_date,
      estimated_hours:        draft.estimated_hours || null,
      is_auto_assigned:       true,
      auto_assign_reason:     `Auto-assigned based on project type "${project.project_type}" and role "${neededRole || neededDept || "any"}"`,
      requires_permission:    requiresPermission,
      permission_description: draft.permission_description || null,
      permission_status:      permStatus,
      required_role:          neededRole,
      required_department:    neededDept,
    });

    createdTasks.push(task);
    usedInThisRound.push(assignee._id.toString());

    // ── Notifications ──────────────────────────────────────────────────────
    await Notification.create({
      user_id:   assignee._id,
      sender_id: assignedById,
      message:   `[Auto-Assigned] New task "${task.title}" has been assigned to you for project.`,
      type:      "auto_assign",
      ref_id:    task._id,
      ref_type:  "Task",
    });

    if (isOnLeave) {
      // Notify manager that this person is on leave but was still assigned
      const project_doc = project; // already have it
      await Notification.create({
        user_id:   assignedById,
        sender_id: null,
        message:   `⚠️ "${assignee.name}" is currently on leave but was auto-assigned task "${task.title}". Consider reassigning.`,
        type:      "leave_cover_assigned",
        ref_id:    task._id,
        ref_type:  "Task",
      });
    }

    if (requiresPermission) {
      await Notification.create({
        user_id:   assignedById,
        sender_id: null,
        message:   `🔐 Task "${task.title}" requires admin permission before work can start. Awaiting approval.`,
        type:      "permission_requested",
        ref_id:    task._id,
        ref_type:  "Task",
      });
    }
  }

  return createdTasks;
}

/**
 * Reassign all open tasks of an employee who is going on leave.
 * Only reassigns tasks with priority "high" or "critical".
 *
 * @param {string} leavingUserId
 * @param {Date}   leaveFrom
 * @param {Date}   leaveTo
 * @param {string} adminId        - Who triggered this
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
    // Find members of the same project with matching role
    const projectMembers = await ProjectMember.find({
      project_id: task.project_id,
      status:     "active",
      user_id:    { $ne: leavingUserId },
    }).populate("user_id");

    let pool = projectMembers.map((pm) => pm.user_id).filter(Boolean);

    // Role-match if task has required_role
    if (task.required_role) {
      pool = pool.filter((u) =>
        u.designation?.toLowerCase().includes(task.required_role.toLowerCase())
      );
    }

    if (!pool.length) {
      // Broaden to all active users
      const query = { status: "active", _id: { $ne: leavingUserId } };
      if (task.required_role) query.designation = { $regex: task.required_role, $options: "i" };
      pool = await User.find(query);
    }

    const newAssignee = await pickBestCandidate(pool, task.due_date);
    if (!newAssignee) continue;

    const previousUser = task.assigned_to;

    task.reassign_logs.push({
      from_user:     previousUser,
      to_user:       newAssignee._id,
      reason:        `Assigned employee is on leave from ${leaveFrom.toDateString()} to ${leaveTo.toDateString()}`,
      reassigned_by: adminId || null,
      trigger:       "leave_cover",
    });
    task.assigned_to = newAssignee._id;
    await task.save();
    reassignedTasks.push(task);

    // Notify new assignee
    await Notification.create({
      user_id:   newAssignee._id,
      sender_id: adminId || null,
      message:   `📋 Task "${task.title}" has been reassigned to you because the original assignee is on leave.`,
      type:      "task_reassigned",
      ref_id:    task._id,
      ref_type:  "Task",
    });

    // Notify admin
    await Notification.create({
      user_id:   adminId,
      sender_id: null,
      message:   `✅ Task "${task.title}" was automatically reassigned from the on-leave employee to "${newAssignee.name}".`,
      type:      "leave_cover_assigned",
      ref_id:    task._id,
      ref_type:  "Task",
    });
  }

  return reassignedTasks;
}

/**
 * Rebalance tasks for an employee who has too many high-priority tasks.
 * Redistributes lowest-priority tasks to other team members.
 *
 * @param {string} userId
 * @param {string} projectId
 * @param {number} maxWorkloadScore  - Threshold above which to rebalance
 * @param {string} adminId
 */
async function rebalanceTasks(userId, projectId, maxWorkloadScore = 200, adminId) {
  const currentScore = await getUserWorkloadScore(userId);
  if (currentScore <= maxWorkloadScore) return [];

  // Get lowest-priority non-critical tasks
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
    const newAssignee = await pickBestCandidate(pool, task.due_date);
    if (!newAssignee) continue;

    task.reassign_logs.push({
      from_user:     userId,
      to_user:       newAssignee._id,
      reason:        "Priority rebalancing — original assignee has too many active tasks",
      reassigned_by: adminId || null,
      trigger:       "priority_rebalance",
    });
    task.assigned_to = newAssignee._id;
    await task.save();
    reassigned.push(task);

    await Notification.create({
      user_id:   newAssignee._id,
      sender_id: adminId || null,
      message:   `📋 Task "${task.title}" has been reassigned to you due to workload rebalancing.`,
      type:      "task_reassigned",
      ref_id:    task._id,
      ref_type:  "Task",
    });
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
  PROJECT_TYPE_ROLES,
};
