const Task         = require("../models/tasks");
const Notification = require("../models/notification");
const mongoose     = require("mongoose");
const {
  rebalanceTasks,
  getUserWorkloadScore,
} = require("../services/autoAssignService");

// ─── Helpers ────────────────────────────────────────────────────────────────

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({
    success: false,
    message: error.message || "Internal server error",
  });
};

const PRIORITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };

// ─── CREATE ─────────────────────────────────────────────────────────────────

/**
 * POST /tasks
 * Create a new task (manual). For auto-assigned tasks use the assignment wizard.
 */
const createTask = async (req, res) => {
  try {
    const {
      project_id, title, description, assigned_to, assigned_by,
      status, priority, due_date, estimated_hours,
      requires_permission, permission_description,
      required_role, required_department,
    } = req.body;

    if (!isValidObjectId(project_id))
      return res.status(400).json({ success: false, message: "Invalid project_id" });
    if (!isValidObjectId(assigned_to))
      return res.status(400).json({ success: false, message: "Invalid assigned_to" });

    const permStatus      = requires_permission ? "pending" : "not_required";
    const effectiveStatus = requires_permission ? "blocked" : (status || "todo");
    const priorityScore   = PRIORITY_SCORE[priority || "medium"] || 50;

    const task = await Task.create({
      project_id, title, description, assigned_to,
      assigned_by: assigned_by || req.user?._id,
      status:      effectiveStatus,
      priority:    priority || "medium",
      priority_score: priorityScore,
      due_date,
      estimated_hours,
      requires_permission:    !!requires_permission,
      permission_description: permission_description || null,
      permission_status:      permStatus,
      required_role:          required_role || null,
      required_department:    required_department || null,
    });

    if (assigned_to && assigned_to.toString() !== req.user?._id?.toString()) {
      await Notification.create({
        user_id:   assigned_to,
        sender_id: req.user?._id ?? null,
        message:   `You have been assigned a new task: "${title}"`,
        type:      "task_assigned",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }

    if (requires_permission) {
      await Notification.create({
        user_id:   req.user?._id,
        sender_id: null,
        message:   `🔐 Task "${title}" requires admin permission. Status: Pending.`,
        type:      "permission_requested",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }

    return res.status(201).json({ success: true, data: task });
  } catch (error) {
    if (error.name === "ValidationError")
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── READ ALL ────────────────────────────────────────────────────────────────

/**
 * GET /tasks
 * Supports filters: project_id, assigned_to, status, priority, is_delayed,
 *                   requires_permission, permission_status, page, limit
 */
const getAllTasks = async (req, res) => {
  try {
    const {
      project_id, assigned_to, status, priority,
      is_delayed, requires_permission, permission_status,
      page = 1, limit = 20,
    } = req.query;

    const filter = {};
    if (project_id)   { if (!isValidObjectId(project_id)) return res.status(400).json({ success: false, message: "Invalid project_id" }); filter.project_id = project_id; }
    if (assigned_to)  { if (!isValidObjectId(assigned_to)) return res.status(400).json({ success: false, message: "Invalid assigned_to" }); filter.assigned_to = assigned_to; }
    if (status)       filter.status = status;
    if (priority)     filter.priority = priority;
    if (is_delayed !== undefined) filter.is_delayed = is_delayed === "true";
    if (requires_permission !== undefined) filter.requires_permission = requires_permission === "true";
    if (permission_status)  filter.permission_status = permission_status;

    const skip = (Number(page) - 1) * Number(limit);

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate("project_id", "title priority status")
        .populate("assigned_to", "name email department designation")
        .populate("assigned_by", "name email")
        .populate("permission_granted_by", "name email")
        .sort({ priority_score: -1, due_date: 1 })
        .skip(skip)
        .limit(Number(limit)),
      Task.countDocuments(filter),
    ]);

    // Auto-flag overdue tasks as delayed
    const today = new Date();
    for (const task of tasks) {
      if (
        task.due_date < today &&
        task.status !== "completed" &&
        task.status !== "cancelled" &&
        !task.is_delayed
      ) {
        await Task.findByIdAndUpdate(task._id, { is_delayed: true });
        task.is_delayed = true;
      }
    }

    return res.status(200).json({
      success: true, total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: tasks,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── READ ONE ────────────────────────────────────────────────────────────────

const getTaskById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const task = await Task.findById(id)
      .populate("project_id", "title priority status project_type")
      .populate("assigned_to", "name email department designation status")
      .populate("assigned_by", "name email")
      .populate("permission_granted_by", "name email")
      .populate("delay_logs.reported_by", "name email")
      .populate("reassign_logs.from_user", "name email")
      .populate("reassign_logs.to_user", "name email")
      .populate("reassign_logs.reassigned_by", "name email");

    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── UPDATE ──────────────────────────────────────────────────────────────────

const updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const updates = { ...req.body };
    delete updates._id;
    delete updates.createdAt;
    delete updates.updatedAt;
    delete updates.delay_logs;
    delete updates.reassign_logs;

    if (updates.status === "completed") {
      updates.completed_at   = updates.completed_at ?? new Date();
      updates.progress_percent = 100;
    } else if (updates.status && updates.status !== "completed") {
      updates.completed_at = null;
    }

    if (updates.priority) {
      updates.priority_score = PRIORITY_SCORE[updates.priority] || 50;
    }

    const task = await Task.findByIdAndUpdate(
      id, { $set: updates }, { new: true, runValidators: true }
    )
      .populate("project_id", "title priority status")
      .populate("assigned_to", "name email department designation")
      .populate("assigned_by", "name email");

    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    if (error.name === "ValidationError")
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── DELETE ──────────────────────────────────────────────────────────────────

const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const task = await Task.findByIdAndDelete(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    return res.status(200).json({ success: true, message: "Task deleted successfully" });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── BULK STATUS UPDATE ──────────────────────────────────────────────────────

const bulkUpdateStatus = async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ success: false, message: "ids must be a non-empty array" });
    if (!ids.every(isValidObjectId))
      return res.status(400).json({ success: false, message: "One or more invalid task IDs" });

    const validStatuses = ["todo", "in-progress", "completed", "on-hold", "cancelled", "blocked"];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(", ")}` });

    const setFields = { status };
    if (status === "completed") { setFields.completed_at = new Date(); setFields.progress_percent = 100; }
    else setFields.completed_at = null;

    const result = await Task.updateMany(
      { _id: { $in: ids } }, { $set: setFields }, { runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} task(s) updated`,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── LOG DELAY ───────────────────────────────────────────────────────────────

/**
 * POST /tasks/:id/delay
 * Employee or manager logs a reason for task delay.
 * Body: { reason, new_due_date? }
 */
const logDelay = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const { reason, new_due_date } = req.body;
    if (!reason || reason.trim().length < 10)
      return res.status(400).json({ success: false, message: "Delay reason must be at least 10 characters" });

    const task = await Task.findById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    const delayEntry = {
      reason:            reason.trim(),
      reported_by:       req.user?._id || null,
      reported_at:       new Date(),
      previous_due_date: task.due_date,
      new_due_date:      new_due_date ? new Date(new_due_date) : null,
    };

    task.delay_logs.push(delayEntry);
    task.is_delayed   = true;
    task.delay_reason = reason.trim();
    if (new_due_date) task.due_date = new Date(new_due_date);

    await task.save();

    // Notify manager/admin
    if (task.assigned_by) {
      await Notification.create({
        user_id:   task.assigned_by,
        sender_id: req.user?._id || null,
        message:   `⚠️ Task "${task.title}" has been marked as delayed. Reason: ${reason.substring(0, 80)}`,
        type:      "task_delayed",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }

    return res.status(200).json({ success: true, message: "Delay logged", data: task });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── UPDATE PROGRESS ─────────────────────────────────────────────────────────

/**
 * PATCH /tasks/:id/progress
 * Update percentage progress and optionally add a progress note.
 * Body: { progress_percent, actual_hours? }
 */
const updateProgress = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const { progress_percent, actual_hours } = req.body;

    if (progress_percent === undefined || progress_percent < 0 || progress_percent > 100)
      return res.status(400).json({ success: false, message: "progress_percent must be 0–100" });

    const updates = { progress_percent };
    if (actual_hours !== undefined) updates.actual_hours = actual_hours;
    if (progress_percent === 100) {
      updates.status       = "completed";
      updates.completed_at = new Date();
    }

    const task = await Task.findByIdAndUpdate(
      id, { $set: updates }, { new: true, runValidators: true }
    ).populate("assigned_to", "name email");

    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (progress_percent === 100 && task.assigned_by) {
      await Notification.create({
        user_id:   task.assigned_by,
        sender_id: req.user?._id || null,
        message:   `✅ Task "${task.title}" has been marked complete by ${task.assigned_to?.name}.`,
        type:      "task_completed",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GRANT PERMISSION ────────────────────────────────────────────────────────

/**
 * PATCH /tasks/:id/permission
 * Admin grants or denies access for a blocked task.
 * Body: { action: "grant" | "deny" }
 */
const handlePermission = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const { action } = req.body;
    if (!["grant", "deny"].includes(action))
      return res.status(400).json({ success: false, message: 'action must be "grant" or "deny"' });

    const task = await Task.findById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    if (task.permission_status === "granted")
      return res.status(400).json({ success: false, message: "Permission already granted" });

    const isGrant = action === "grant";
    task.permission_status      = isGrant ? "granted" : "denied";
    task.permission_granted_by  = req.user._id;
    task.permission_granted_at  = new Date();
    if (isGrant && task.status === "blocked") task.status = "todo";

    await task.save();

    await Notification.create({
      user_id:   task.assigned_to,
      sender_id: req.user._id,
      message:   isGrant
        ? `✅ Permission granted for task "${task.title}". You can start work now.`
        : `❌ Permission denied for task "${task.title}". Please contact your manager.`,
      type:      isGrant ? "permission_granted" : "permission_denied",
      ref_id:    task._id,
      ref_type:  "Task",
    }).catch(console.error);

    return res.status(200).json({
      success: true,
      message: `Permission ${action}ed for task`,
      data: task,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── MANUAL REASSIGN ─────────────────────────────────────────────────────────

/**
 * PATCH /tasks/:id/reassign
 * Manually reassign a task to another employee.
 * Body: { new_assignee_id, reason }
 */
const reassignTask = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid task ID" });

    const { new_assignee_id, reason } = req.body;
    if (!isValidObjectId(new_assignee_id))
      return res.status(400).json({ success: false, message: "Invalid new_assignee_id" });

    const task = await Task.findById(id);
    if (!task)
      return res.status(404).json({ success: false, message: "Task not found" });

    const previousAssignee = task.assigned_to;

    task.reassign_logs.push({
      from_user:     previousAssignee,
      to_user:       new_assignee_id,
      reason:        reason || "Manual reassignment",
      reassigned_by: req.user._id,
      trigger:       "manual",
    });
    task.assigned_to = new_assignee_id;
    await task.save();

    await Notification.create({
      user_id:   new_assignee_id,
      sender_id: req.user._id,
      message:   `📋 Task "${task.title}" has been reassigned to you. Reason: ${reason || "Not specified"}`,
      type:      "task_reassigned",
      ref_id:    task._id,
      ref_type:  "Task",
    }).catch(console.error);

    return res.status(200).json({ success: true, message: "Task reassigned", data: task });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── STATS ───────────────────────────────────────────────────────────────────

const getTaskStats = async (req, res) => {
  try {
    const { project_id, assigned_to } = req.query;

    const match = {};
    if (project_id) {
      if (!isValidObjectId(project_id))
        return res.status(400).json({ success: false, message: "Invalid project_id" });
      match.project_id = new mongoose.Types.ObjectId(project_id);
    }
    if (assigned_to) {
      if (!isValidObjectId(assigned_to))
        return res.status(400).json({ success: false, message: "Invalid assigned_to" });
      match.assigned_to = new mongoose.Types.ObjectId(assigned_to);
    }

    const [statusStats, delayStats, permissionStats] = await Promise.all([
      Task.aggregate([
        { $match: match },
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort:  { _id: 1 } },
      ]),
      Task.aggregate([
        { $match: { ...match, is_delayed: true } },
        { $count: "delayed_count" },
      ]),
      Task.aggregate([
        { $match: { ...match, requires_permission: true } },
        { $group: { _id: "$permission_status", count: { $sum: 1 } } },
      ]),
    ]);

    const summary = statusStats.reduce((acc, { _id, count }) => {
      acc[_id] = count; return acc;
    }, {});

    const permSummary = permissionStats.reduce((acc, { _id, count }) => {
      acc[_id] = count; return acc;
    }, {});

    return res.status(200).json({
      success: true,
      data: {
        by_status:     summary,
        delayed_count: delayStats[0]?.delayed_count || 0,
        permissions:   permSummary,
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── WORKLOAD OVERVIEW ────────────────────────────────────────────────────────

/**
 * GET /tasks/workload?project_id=
 * Returns per-employee task counts and workload scores for a project.
 */
const getWorkloadOverview = async (req, res) => {
  try {
    const { project_id } = req.query;
    const match = { status: { $in: ["todo", "in-progress", "on-hold"] } };
    if (project_id) {
      if (!isValidObjectId(project_id))
        return res.status(400).json({ success: false, message: "Invalid project_id" });
      match.project_id = new mongoose.Types.ObjectId(project_id);
    }

    const grouped = await Task.aggregate([
      { $match: match },
      {
        $group: {
          _id:        "$assigned_to",
          task_count: { $sum: 1 },
          priorities: { $push: "$priority" },
        },
      },
      {
        $lookup: {
          from: "users", localField: "_id", foreignField: "_id", as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $project: {
          name:        "$user.name",
          email:       "$user.email",
          designation: "$user.designation",
          department:  "$user.department",
          task_count:  1,
          priorities:  1,
        },
      },
    ]);

    const result = grouped.map((g) => {
      const score = g.priorities.reduce(
        (s, p) => s + ({ critical: 100, high: 75, medium: 50, low: 25 }[p] || 0), 0
      );
      return { ...g, workload_score: score };
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  createTask,
  getAllTasks,
  getTaskById,
  updateTask,
  deleteTask,
  bulkUpdateStatus,
  logDelay,
  updateProgress,
  handlePermission,
  reassignTask,
  getTaskStats,
  getWorkloadOverview,
};
