const Task          = require('../models/tasks');
const Project = require('../models/project');
const User          = require('../models/users');
const Leave         = require('../models/leave');
const Notification  = require('../models/notification');
const ProjectMember = require('../models/project_member');
const workloadCache = require('./workloadCache');
const log           = require('./assignmentLogger');
const { scheduleTasksWithWorkload, getUserRoleEndDates } = require('./schedulingEngine');

// ─── Constants ────────────────────────────────────────────────────────────────

const PROJECT_TYPE_ROLES = {
  website: [
    { role: 'frontend developer',   department: 'Web Development', priority_order: 1 },
    { role: 'backend developer',    department: 'Web Development', priority_order: 2 },
    { role: 'full stack developer', department: 'Web Development', priority_order: 3 },
    { role: 'designer',             department: 'Design',          priority_order: 4 },
  ],
  mobile_app: [
    { role: 'mobile developer',     department: 'Mobile',          priority_order: 1 },
    { role: 'backend developer',    department: 'Web Development', priority_order: 2 },
    { role: 'designer',             department: 'Design',          priority_order: 3 },
  ],
  ecommerce: [
    { role: 'full stack developer', department: 'Web Development', priority_order: 1 },
    { role: 'backend developer',    department: 'Web Development', priority_order: 2 },
    { role: 'seo specialist',       department: 'SEO',             priority_order: 3 },
    { role: 'designer',             department: 'Design',          priority_order: 4 },
  ],
  api_service: [
    { role: 'backend developer',    department: 'Web Development', priority_order: 1 },
    { role: 'full stack developer', department: 'Web Development', priority_order: 2 },
  ],
  data_analytics: [
    { role: 'data analyst',         department: 'Analytics',       priority_order: 1 },
    { role: 'backend developer',    department: 'Web Development', priority_order: 2 },
  ],
  design:    [{ role: 'designer',             department: 'Design',          priority_order: 1 }],
  content:   [{ role: 'content writer',       department: 'Content Writing', priority_order: 1 }],
  seo:       [{ role: 'seo specialist',       department: 'SEO',             priority_order: 1 },
              { role: 'content writer',       department: 'Content Writing', priority_order: 2 }],
  marketing: [{ role: 'marketing specialist', department: 'Social Media',    priority_order: 1 },
              { role: 'content writer',       department: 'Content Writing', priority_order: 2 }],
};

const PRIORITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };
const MAX_WORKLOAD_SCORE = 300;

// ─── Workload ─────────────────────────────────────────────────────────────────

/**
 * Get workload score. Uses cache when available to avoid repeated DB hits.
 * Falls back to DB on cache miss (workloadCache handles this transparently).
 */
async function getUserWorkloadScore(userId) {
  return workloadCache.getScore(userId);
}

async function getUserActiveProjectCount(userId) {
  const tasks = await Task.distinct('project_id', {
    assigned_to: userId,
    status: { $in: ['todo', 'in-progress', 'on-hold'] },
  });
  return tasks.length;
}

// ─── Leave ────────────────────────────────────────────────────────────────────

async function isUserOnLeave(userId, date = new Date()) {
  const leave = await Leave.findOne({
    user_id:   userId,
    status:    'approved',
    from_date: { $lte: date },
    to_date:   { $gte: date },
  });
  return !!leave;
}

// ─── Candidate picking ────────────────────────────────────────────────────────

/**
 * Pick the best candidate from a pool.
 * Uses cached workload scores — assumes warmUp() was called before batch loops.
 */
async function pickBestCandidate(candidateUsers, taskStartDate, excludeUserIds = []) {
  const checkDate = taskStartDate ? new Date(taskStartDate) : new Date();

  const scored = await Promise.all(
    candidateUsers
      .filter((u) => !excludeUserIds.includes(u._id.toString()) && u.status === 'active')
      .map(async (u) => {
        const onLeave      = await isUserOnLeave(u._id, checkDate);
        const workload     = await getUserWorkloadScore(u._id);  // uses cache
        const projectCount = await getUserActiveProjectCount(u._id);
        return { user: u, onLeave, workload, projectCount };
      })
  );

  const available = scored
    .filter((s) => !s.onLeave)
    .sort((a, b) => a.workload - b.workload || a.projectCount - b.projectCount);

  if (available.length) return available[0].user;

  const fallback = scored.sort((a, b) => a.workload - b.workload);
  return fallback.length ? fallback[0].user : null;
}

// ─── Main auto-assign ─────────────────────────────────────────────────────────

/**
 * Auto-assign tasks for a project.
 *
 * PERFORMANCE: Warms workload cache for all candidate users before the loop,
 * then uses cached values throughout. Single bulk DB query instead of N queries.
 */
async function autoAssignProjectTasks(project, taskDrafts, assignedById) {
  log.info('autoAssignProjectTasks started', {
    projectId: project._id?.toString(),
    draftCount: taskDrafts.length,
  });

  const createdTasks = [];
  const assignmentCount = {};

  // Pre-collect all candidate users across all drafts for cache warm-up
  const allCandidateIds = new Set();
  for (const draft of taskDrafts) {
    const pool = await _buildCandidatePool(project._id, draft);
    pool.forEach((u) => allCandidateIds.add(u._id.toString()));
  }
  // Warm cache in ONE batch query
  if (allCandidateIds.size > 0) {
    await workloadCache.warmUp([...allCandidateIds]);
  }

  for (const draft of taskDrafts) {
    try {
      const pool = await _buildCandidatePool(project._id, draft);

      if (!pool.length) {
        log.skip({ taskId: null, taskTitle: draft.title, reason: 'No matching candidates in pool' });
        continue;
      }

      pool.sort((a, b) => {
        const countA = assignmentCount[a._id.toString()] || 0;
        const countB = assignmentCount[b._id.toString()] || 0;
        return countA - countB;
      });

      const assignee = await pickBestCandidate(pool, draft.start_date || new Date(), []);
      if (!assignee) {
        log.skip({ taskId: null, taskTitle: draft.title, reason: 'All candidates on leave or overloaded' });
        continue;
      }

      // Schedule dates around assignee's existing workload if not provided
      let taskStart = draft.start_date;
      let taskEnd   = draft.end_date;
      let taskDue   = draft.due_date;

      if (!taskStart) {
        const existingTasks = await Task.find({
          assigned_to:   assignee._id,
          required_role: draft.required_role,
          status: { $in: ['todo', 'in-progress', 'on-hold'] },
        }).select('end_date required_role');

        const existingWorkload = getUserRoleEndDates(existingTasks);
        const [rescheduled] = scheduleTasksWithWorkload([draft], project.start_date, existingWorkload);
        taskStart = rescheduled.start_date;
        taskEnd   = rescheduled.end_date;
        taskDue   = rescheduled.due_date;
      }

      const isOnLeave     = await isUserOnLeave(assignee._id);
      const projectBonus  = project.priority === 'critical' ? 30 : project.priority === 'high' ? 15 : 0;
      const priorityScore = (PRIORITY_SCORE[draft.priority || 'medium'] || 50) + projectBonus;

      const task = await Task.create({
        project_id:             project._id,
        assignment_id:          draft.assignment_id || null,
        title:                  draft.title,
        description:            draft.description || null,
        module_name:            draft.module_name || null,
        assigned_to:            assignee._id,
        assigned_by:            assignedById,
        status:                 draft.requires_permission ? 'blocked' : 'todo',
        priority:               draft.priority || 'medium',
        priority_score:         priorityScore,
        start_date:             taskStart,
        end_date:               taskEnd,
        due_date:               taskDue || taskEnd,
        estimated_days:         draft.estimated_days || 1,
        estimated_hours:        draft.estimated_hours || null,
        is_auto_assigned:       true,
        auto_assign_reason:     `Auto-assigned: role="${draft.required_role || 'any'}", workload=${await getUserWorkloadScore(assignee._id)}`,
        requires_permission:    !!draft.requires_permission,
        permission_description: draft.permission_description || null,
        permission_status:      draft.requires_permission ? 'pending' : 'not_required',
        required_role:          draft.required_role || null,
        required_department:    draft.required_department || null,
      });

      createdTasks.push(task);

      // Invalidate cache for this user — their score just changed
      workloadCache.invalidate(assignee._id);

      const uid = assignee._id.toString();
      assignmentCount[uid] = (assignmentCount[uid] || 0) + 1;

      log.assign({
        taskId:       task._id,
        taskTitle:    task.title,
        userId:       assignee._id,
        userName:     assignee.name,
        reason:       task.auto_assign_reason,
        workloadScore: await getUserWorkloadScore(assignee._id),
      });

      await ProjectMember.findOneAndUpdate(
        { project_id: project._id, user_id: assignee._id },
        { project_id: project._id, user_id: assignee._id, role_in_project: 'developer' },
        { upsert: true, new: true }
      ).catch(() => {});

      await Notification.create({
        user_id:   assignee._id,
        sender_id: assignedById,
        message:   `[Auto-Assigned] Task "${task.title}" assigned. Starts: ${taskStart ? new Date(taskStart).toDateString() : 'TBD'}, Due: ${taskEnd ? new Date(taskEnd).toDateString() : 'TBD'}.`,
        type:      'auto_assign',
        ref_id:    task._id,
        ref_type:  'Task',
      }).catch(console.error);

      if (isOnLeave) {
        await Notification.create({
          user_id:   assignedById,
          sender_id: null,
          message:   `⚠️ "${assignee.name}" is on leave but was auto-assigned task "${task.title}". Consider reassigning.`,
          type:      'leave_cover_assigned',
          ref_id:    task._id,
          ref_type:  'Task',
        }).catch(console.error);
      }
    } catch (err) {
      log.error({ taskId: null, taskTitle: draft.title, err });
    }
  }

  log.info('autoAssignProjectTasks complete', {
    projectId:    project._id?.toString(),
    assigned:     createdTasks.length,
    skipped:      taskDrafts.length - createdTasks.length,
  });

  return createdTasks;
}

// ─── NEW: Auto-reassign on task update ───────────────────────────────────────

/**
 * Called when a task's priority or deadline changes significantly.
 *
 * Decision logic:
 *  1. If priority upgraded to 'high'/'critical' AND current assignee is overloaded
 *     → find a less-loaded candidate and reassign
 *  2. If assigned_to was cleared (null) → re-run assignment from scratch
 *  3. Otherwise → no reassignment needed (minor change)
 *
 * This is called by workflowHandlers.js on the 'task:updated' event.
 * It does NOT reassign on every edit — only when the change is meaningful.
 *
 * @param {Object} taskId    - Mongoose ObjectId
 * @param {Object} before    - task fields BEFORE update { priority, assigned_to, due_date }
 * @param {Object} after     - task fields AFTER update
 * @param {string} adminId   - who triggered the update
 */
async function autoReassignOnTaskUpdate(taskId, before, after, adminId) {
  const task = await Task.findById(taskId).populate('project_id');
  if (!task) return;

  // Case 1: Assignee was removed → re-assign from scratch
  if (before.assigned_to && !after.assigned_to) {
    log.info('Re-assigning: assignee was removed', { taskId: taskId.toString() });

    const pool = await _buildCandidatePool(task.project_id._id, {
      required_role:       task.required_role,
      required_department: task.required_department,
    });

    if (!pool.length) {
      log.skip({ taskId, taskTitle: task.title, reason: 'No candidates for re-assignment after assignee removed' });
      return;
    }

    await workloadCache.warmUp(pool.map((u) => u._id));
    const newAssignee = await pickBestCandidate(pool, task.start_date || new Date(), []);
    if (!newAssignee) return;

    task.reassign_logs.push({
      from_user:     before.assigned_to,
      to_user:       newAssignee._id,
      reason:        'Assignee removed — auto-reassigned to least-loaded candidate',
      reassigned_by: adminId || null,
      trigger:       'auto_assign',
    });
    task.assigned_to = newAssignee._id;
    await task.save();

    workloadCache.invalidate(newAssignee._id);
    log.assign({ taskId, taskTitle: task.title, userId: newAssignee._id, userName: newAssignee.name, reason: 'Assignee removed' });

    await Notification.create({
      user_id:   newAssignee._id,
      sender_id: adminId || null,
      message:   `📋 Task "${task.title}" auto-reassigned to you (previous assignee removed).`,
      type:      'task_reassigned',
      ref_id:    task._id,
      ref_type:  'Task',
    }).catch(console.error);
    return;
  }

  // Case 2: Priority escalated to high/critical AND current assignee is overloaded
  const priorityEscalated =
    before.priority !== after.priority &&
    (after.priority === 'critical' || after.priority === 'high') &&
    (before.priority === 'low' || before.priority === 'medium');

  if (priorityEscalated && task.assigned_to) {
    const currentScore = await getUserWorkloadScore(task.assigned_to);

    if (currentScore > MAX_WORKLOAD_SCORE) {
      log.info('Re-assigning: priority escalated + current assignee overloaded', {
        taskId: taskId.toString(),
        currentScore,
        threshold: MAX_WORKLOAD_SCORE,
      });

      const pool = await _buildCandidatePool(task.project_id._id, {
        required_role:       task.required_role,
        required_department: task.required_department,
      });

      await workloadCache.warmUp(pool.map((u) => u._id));
      const newAssignee = await pickBestCandidate(
        pool,
        task.start_date || new Date(),
        [task.assigned_to.toString()]   // exclude current overloaded assignee
      );

      if (newAssignee) {
        const prevAssigneeId = task.assigned_to;
        task.reassign_logs.push({
          from_user:     prevAssigneeId,
          to_user:       newAssignee._id,
          reason:        `Priority escalated to ${after.priority} and original assignee overloaded (score: ${currentScore})`,
          reassigned_by: adminId || null,
          trigger:       'priority_rebalance',
        });
        task.assigned_to = newAssignee._id;
        await task.save();

        workloadCache.invalidate(prevAssigneeId);
        workloadCache.invalidate(newAssignee._id);

        log.rebalance({
          taskId,
          taskTitle:    task.title,
          fromUserId:   prevAssigneeId,
          toUserId:     newAssignee._id,
          toUserName:   newAssignee.name,
          reason:       `Priority escalation + overload`,
        });

        await Notification.create({
          user_id:   newAssignee._id,
          sender_id: adminId || null,
          message:   `🔴 High-priority task "${task.title}" reassigned to you (priority escalated).`,
          type:      'task_reassigned',
          ref_id:    task._id,
          ref_type:  'Task',
        }).catch(console.error);
      }
    }
  }
}

// ─── Leave reassignment ───────────────────────────────────────────────────────

async function handleLeaveReassignment(leavingUserId, leaveFrom, leaveTo, adminId) {
  const urgentTasks = await Task.find({
    assigned_to: leavingUserId,
    status:      { $in: ['todo', 'in-progress'] },
    priority:    { $in: ['high', 'critical'] },
    due_date:    { $gte: leaveFrom, $lte: leaveTo },
  });

  const reassignedTasks = [];

  for (const task of urgentTasks) {
    const pool = await _buildCandidatePool(task.project_id, {
      required_role: task.required_role,
      required_department: task.required_department,
    }, leavingUserId);

    if (!pool.length) continue;

    await workloadCache.warmUp(pool.map((u) => u._id));
    const newAssignee = await pickBestCandidate(pool, task.start_date || task.due_date);
    if (!newAssignee) continue;

    task.reassign_logs.push({
      from_user:     leavingUserId,
      to_user:       newAssignee._id,
      reason:        `Employee on leave from ${leaveFrom.toDateString()} to ${leaveTo.toDateString()}`,
      reassigned_by: adminId || null,
      trigger:       'leave_cover',
    });
    task.assigned_to = newAssignee._id;
    await task.save();
    reassignedTasks.push(task);

    workloadCache.invalidate(leavingUserId);
    workloadCache.invalidate(newAssignee._id);

    log.leaveReassign({
      taskId:       task._id,
      taskTitle:    task.title,
      fromUserId:   leavingUserId,
      toUserId:     newAssignee._id,
      toUserName:   newAssignee.name,
    });

    await Notification.create({
      user_id:   newAssignee._id,
      sender_id: adminId || null,
      message:   `📋 Task "${task.title}" reassigned to you — original assignee is on leave.`,
      type:      'task_reassigned',
      ref_id:    task._id,
      ref_type:  'Task',
    }).catch(console.error);
  }

  return reassignedTasks;
}

// ─── Workload rebalancing ─────────────────────────────────────────────────────

/**
 * UPDATED: Rebalances globally across ALL projects (not just one).
 * Triggered by: cron job, high-priority task creation, leave approval.
 *
 * Strategy:
 *  1. Find all overloaded users (score > threshold)
 *  2. For each overloaded user, find their lowest-priority todo tasks
 *  3. Redistribute those tasks to least-loaded project members
 *
 * @param {string|null} projectId   - if null, rebalances across ALL projects
 * @param {number}      maxScore    - workload threshold
 * @param {string}      adminId     - who triggered rebalance
 */
async function rebalanceTasks(projectId = null, maxScore = MAX_WORKLOAD_SCORE, adminId = null) {
  log.info('rebalanceTasks started', { projectId: projectId?.toString(), maxScore });

  // Find users who are currently overloaded
  const activeTaskQuery = { status: { $in: ['todo', 'in-progress', 'on-hold'] } };
  if (projectId) activeTaskQuery.project_id = projectId;

  const activeTasks = await Task.find(activeTaskQuery).select('assigned_to priority');

  // Compute score per user from live data
  const scoreMap = {};
  for (const t of activeTasks) {
    const uid = t.assigned_to?.toString();
    if (!uid) continue;
    scoreMap[uid] = (scoreMap[uid] || 0) + (PRIORITY_SCORE[t.priority] || 0);
  }

  const overloadedUserIds = Object.entries(scoreMap)
    .filter(([, score]) => score > maxScore)
    .map(([uid]) => uid);

  if (overloadedUserIds.length === 0) {
    log.info('rebalanceTasks: no overloaded users found');
    return [];
  }

  log.info(`rebalanceTasks: ${overloadedUserIds.length} overloaded user(s)`);

  const reassigned = [];

  for (const userId of overloadedUserIds) {
    const overflowQuery = {
      assigned_to: userId,
      status:      { $in: ['todo'] },
      priority:    { $in: ['low', 'medium'] },
    };
    if (projectId) overflowQuery.project_id = projectId;

    const overflowTasks = await Task.find(overflowQuery)
      .sort({ priority_score: 1 })
      .limit(3);

    for (const task of overflowTasks) {
      const pool = await _buildCandidatePool(task.project_id, {
        required_role:       task.required_role,
        required_department: task.required_department,
      }, userId);

      if (!pool.length) continue;

      await workloadCache.warmUp(pool.map((u) => u._id));
      const newAssignee = await pickBestCandidate(pool, task.start_date || task.due_date);
      if (!newAssignee) continue;

      const fromUser = await User.findById(userId).select('name').lean();
      task.reassign_logs.push({
        from_user:     userId,
        to_user:       newAssignee._id,
        reason:        `Workload rebalancing (score ${scoreMap[userId]} > threshold ${maxScore})`,
        reassigned_by: adminId || null,
        trigger:       'priority_rebalance',
      });
      task.assigned_to = newAssignee._id;
      await task.save();
      reassigned.push(task);

      workloadCache.invalidate(userId);
      workloadCache.invalidate(newAssignee._id);

      log.rebalance({
        taskId:       task._id,
        taskTitle:    task.title,
        fromUserId:   userId,
        fromUserName: fromUser?.name,
        toUserId:     newAssignee._id,
        toUserName:   newAssignee.name,
        reason:       `Score ${scoreMap[userId]} exceeded threshold ${maxScore}`,
      });

      await Notification.create({
        user_id:   newAssignee._id,
        sender_id: adminId || null,
        message:   `📋 Task "${task.title}" reassigned to you due to workload rebalancing.`,
        type:      'task_reassigned',
        ref_id:    task._id,
        ref_type:  'Task',
      }).catch(console.error);
    }
  }

  log.info('rebalanceTasks complete', { reassigned: reassigned.length });
  return reassigned;
}

// ─── Internal helper ─────────────────────────────────────────────────────────

async function _buildCandidatePool(projectId, draft, excludeUserId = null) {
  const neededRole = draft.required_role || null;
  const neededDept = draft.required_department || null;

  const memberQuery = { project_id: projectId, status: 'active' };
  if (excludeUserId) memberQuery.user_id = { $ne: excludeUserId };

  const projectMembers = await ProjectMember.find(memberQuery).populate('user_id');
  let pool = projectMembers.map((pm) => pm.user_id).filter(Boolean);

  if (neededRole && pool.length) {
    pool = pool.filter((u) =>
      u.designation?.toLowerCase().includes(neededRole.toLowerCase()) ||
      u.department?.toLowerCase().includes(neededRole.toLowerCase())
    );
  } else if (neededDept && pool.length) {
    pool = pool.filter((u) =>
      u.department?.toLowerCase().includes(neededDept.toLowerCase())
    );
  }

  if (!pool.length) {
    const query = { status: 'active', role: 'employee' };
    if (excludeUserId) query._id = { $ne: excludeUserId };
    // Respect the project's selected team, if one was saved. Prevents the
    // fallback from leaking tasks to every employee company-wide.
    try {
      const proj = await Project.findById(projectId).select('team_members').lean();
      if (proj && Array.isArray(proj.team_members) && proj.team_members.length > 0) {
        query._id = query._id
          ? { ...query._id, $in: proj.team_members }
          : { $in: proj.team_members };
      }
    } catch (_) { /* if lookup fails, fall through to unscoped */ }
    if (neededRole) query.designation = { $regex: neededRole, $options: 'i' };
    else if (neededDept) query.department = { $regex: neededDept, $options: 'i' };
    pool = await User.find(query);
  }

  return pool;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  autoAssignProjectTasks,
  autoReassignOnTaskUpdate,
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