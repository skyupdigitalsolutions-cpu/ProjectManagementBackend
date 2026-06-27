/**
 * controllers/taskController.js  — UPDATED
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANGES vs original:
 *  1. addSubtask        — POST  /tasks/:id/subtasks
 *  2. updateSubtask     — PATCH /tasks/:id/subtasks/:subtaskId
 *  3. deleteSubtask     — DELETE /tasks/:id/subtasks/:subtaskId
 *  4. updateTaskStatus  — PATCH /tasks/:id/status (dedicated, simpler endpoint)
 * All original functions are preserved unchanged.
 */

const Task         = require('../models/tasks');
const User         = require('../models/users');
const Notification = require('../models/notification');
const mongoose     = require('mongoose');
const eventBus     = require('../services/eventBus');
const {
  rebalanceTasks,
  getUserWorkloadScore,
} = require('../services/autoAssignService');

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({ success: false, message: error.message || 'Internal server error' });
};

const PRIORITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };

// ─── Role-based task visibility ────────────────────────────────────────────────
//
//   admin    → all tasks                        → {}
//   manager  → tasks of employees in their own
//              department + their own tasks      → { assigned_to: { $in: [...] } }
//   employee → only tasks assigned to them       → { assigned_to: self }
//
// Returns a Mongo filter fragment to be merged into the main query / $match.
async function buildTaskScope(user) {
  if (user.role === 'admin') return {};

  if (user.role === 'manager') {
    const deptEmployees = await User.find({
      department: user.department,
      role:       'employee',
    }).select('_id').lean();

    const ids = deptEmployees.map((u) => u._id);
    ids.push(user._id);                       // include the manager's own tasks
    return { assigned_to: { $in: ids } };
  }

  // employee (and any non-privileged role) → own tasks only
  return { assigned_to: user._id };
}

// True if `assigneeId` (string) is visible under the given scope fragment.
function assigneeAllowed(scope, assigneeId) {
  if (!scope.assigned_to) return true;        // admin: unrestricted
  const a = scope.assigned_to;
  if (a.$in) return a.$in.some((x) => x.toString() === assigneeId);
  return a.toString() === assigneeId;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

const createTask = async (req, res) => {
  try {
    const {
      project_id, assignment_id, title, description, assigned_to, assigned_by,
      status, priority, due_date, estimated_hours,
      requires_permission, permission_description,
      required_role, required_department,
    } = req.body;

    if (!isValidObjectId(project_id))
      return res.status(400).json({ success: false, message: 'Invalid project_id' });
    if (assigned_to && !isValidObjectId(assigned_to))
      return res.status(400).json({ success: false, message: 'Invalid assigned_to' });

    const permStatus      = requires_permission ? 'pending' : 'not_required';
    const effectiveStatus = requires_permission ? 'blocked' : (status || 'todo');
    const priorityScore   = PRIORITY_SCORE[priority || 'medium'] || 50;

    const task = await Task.create({
      project_id, title, description, assigned_to: assigned_to || null,
      assignment_id: assignment_id || null,
      assigned_by:            assigned_by || req.user?._id,
      status:                 effectiveStatus,
      priority:               priority || 'medium',
      priority_score:         priorityScore,
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
        type:      'task_assigned',
        ref_id:    task._id,
        ref_type:  'Task',
      }).catch(console.error);
    }

    if (requires_permission) {
      await Notification.create({
        user_id:   req.user?._id,
        sender_id: null,
        message:   `🔐 Task "${title}" requires admin permission. Status: Pending.`,
        type:      'permission_requested',
        ref_id:    task._id,
        ref_type:  'Task',
      }).catch(console.error);
    }

    eventBus.emitAsync('task:created', {
      task,
      adminId: req.user?._id,
    }).catch((err) => console.error('[EVENT] task:created handler error:', err.message));

    return res.status(201).json({ success: true, data: task });
  } catch (error) {
    if (error.name === 'ValidationError')
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── READ ALL ─────────────────────────────────────────────────────────────────

const getAllTasks = async (req, res) => {
  try {
    const {
      project_id, assigned_to, status, priority,
      is_delayed, requires_permission, permission_status,
      page = 1, limit = 20,
      required_role, required_department, excel_import,
    } = req.query;

    const filter = {};
    if (project_id)  { if (!isValidObjectId(project_id))  return res.status(400).json({ success: false, message: 'Invalid project_id' });  filter.project_id  = project_id; }
    if (assigned_to && !isValidObjectId(assigned_to)) return res.status(400).json({ success: false, message: 'Invalid assigned_to' });
    if (status)    filter.status   = status;
    if (priority)  filter.priority = priority;
    if (is_delayed !== undefined)         filter.is_delayed           = is_delayed === 'true';
    if (requires_permission !== undefined) filter.requires_permission  = requires_permission === 'true';
    if (permission_status)                 filter.permission_status    = permission_status;
    if (required_role)       filter.required_role       = { $regex: required_role.trim(),       $options: 'i' };
    if (required_department) filter.required_department = { $regex: required_department.trim(), $options: 'i' };
    if (excel_import !== undefined) filter.excel_import = excel_import === 'true';

    // ── Role-based visibility (admin: all · manager: dept + own · employee: own) ──
    const scope = await buildTaskScope(req.user);
    Object.assign(filter, scope);

    // If a specific assignee was requested, it must fall inside the caller's scope.
    if (assigned_to) {
      if (!assigneeAllowed(scope, assigned_to)) {
        // Caller asked for someone they're not allowed to see → empty result.
        return res.status(200).json({ success: true, total: 0, page: Number(page), pages: 0, data: [] });
      }
      filter.assigned_to = assigned_to;       // narrow within the allowed scope
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate('project_id',  'title priority status')
        .populate('assigned_to', 'name email department designation')
        .populate('assigned_by', 'name email')
        .populate('subtasks.assigned_to', 'name email')
        .sort({ priority_score: -1, due_date: 1 })
        .skip(skip)
        .limit(Number(limit)),
      Task.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true, total,
      page:    Number(page),
      pages:   Math.ceil(total / Number(limit)),
      data:    tasks,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── READ ONE ─────────────────────────────────────────────────────────────────

const getTaskById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const task = await Task.findById(id)
      .populate('project_id',  'title priority status start_date end_date')
      .populate('assigned_to', 'name email department designation')
      .populate('assigned_by', 'name email')
      .populate('permission_granted_by', 'name email')
      .populate('subtasks.assigned_to',  'name email');

    if (!task)
      return res.status(404).json({ success: false, message: 'Task not found' });

    // Enforce the same visibility scope as the list view.
    const scope = await buildTaskScope(req.user);
    if (!assigneeAllowed(scope, task.assigned_to?.toString() ?? '')) {
      return res.status(403).json({ success: false, message: 'Not authorised to view this task' });
    }

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────

const updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const isAdmin   = req.user.role === 'admin';
    const isManager = req.user.role === 'manager';
    const isOwner   = task.assigned_to?.toString() === req.user._id.toString();

    if (!isAdmin && !isManager && !isOwner)
      return res.status(403).json({ success: false, message: 'Not authorised' });

    const updates = { ...req.body };
    delete updates._id;
    delete updates.createdAt;
    delete updates.updatedAt;
    delete updates.subtasks; // subtasks managed via dedicated endpoints

    if (updates.priority) {
      updates.priority_score = PRIORITY_SCORE[updates.priority] || 50;
    }
    if (updates.status === 'completed') {
      updates.completed_at    = updates.completed_at ?? new Date();
      updates.progress_percent = 100;
    } else if (updates.status && updates.status !== 'completed') {
      updates.completed_at = null;
    }

    const updated = await Task.findByIdAndUpdate(
      id, { $set: updates }, { new: true, runValidators: true }
    )
      .populate('assigned_to', 'name email')
      .populate('assigned_by', 'name email');

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    if (error.name === 'ValidationError')
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── UPDATE TASK STATUS (dedicated endpoint) ──────────────────────────────────

/**
 * PATCH /tasks/:id/status
 * Body: { status }
 * Simpler endpoint used by kanban / quick-status-change UIs.
 */
const updateTaskStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const validStatuses = ['todo', 'in-progress', 'completed', 'on-hold', 'cancelled', 'blocked', 'unassigned'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const isAdmin   = req.user.role === 'admin';
    const isManager = req.user.role === 'manager';
    const isOwner   = task.assigned_to?.toString() === req.user._id.toString();

    if (!isAdmin && !isManager && !isOwner)
      return res.status(403).json({ success: false, message: 'Not authorised to update this task' });

    const statusUpdates = { status };
    if (status === 'completed') {
      statusUpdates.completed_at    = new Date();
      statusUpdates.progress_percent = 100;
    } else {
      statusUpdates.completed_at = null;
    }

    const updated = await Task.findByIdAndUpdate(
      id, { $set: statusUpdates }, { new: true }
    ).populate('assigned_to', 'name email');

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── DELETE ───────────────────────────────────────────────────────────────────

const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const task = await Task.findByIdAndDelete(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    return res.status(200).json({ success: true, message: 'Task deleted' });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── BULK STATUS ──────────────────────────────────────────────────────────────

const bulkUpdateStatus = async (req, res) => {
  try {
    const { task_ids, status } = req.body;

    if (!Array.isArray(task_ids) || task_ids.length === 0)
      return res.status(400).json({ success: false, message: 'task_ids must be a non-empty array' });

    const validStatuses = ['todo', 'in-progress', 'completed', 'on-hold', 'cancelled', 'blocked'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, message: `Invalid status: ${status}` });

    const extraUpdates = status === 'completed'
      ? { completed_at: new Date(), progress_percent: 100 }
      : { completed_at: null };

    const result = await Task.updateMany(
      { _id: { $in: task_ids } },
      { $set: { status, ...extraUpdates } }
    );

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} task(s) updated to '${status}'`,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── LOG DELAY ────────────────────────────────────────────────────────────────

const logDelay = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, new_due_date } = req.body;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    if (!reason)
      return res.status(400).json({ success: false, message: 'reason is required' });

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const delayEntry = {
      reason,
      reported_by:       req.user._id,
      reported_at:       new Date(),
      previous_due_date: task.due_date,
      new_due_date:      new_due_date ? new Date(new_due_date) : null,
    };

    const updateSet = {
      is_delayed:   true,
      delay_reason: reason,
    };
    if (new_due_date) {
      updateSet.due_date = new Date(new_due_date);
      updateSet.end_date = new Date(new_due_date);
    }

    const updated = await Task.findByIdAndUpdate(
      id,
      { $push: { delay_logs: delayEntry }, $set: updateSet },
      { new: true }
    );

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── PROGRESS ─────────────────────────────────────────────────────────────────

const updateProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const { progress_percent } = req.body;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const percent = Number(progress_percent);
    if (isNaN(percent) || percent < 0 || percent > 100)
      return res.status(400).json({ success: false, message: 'progress_percent must be 0–100' });

    const updated = await Task.findByIdAndUpdate(
      id,
      {
        $set: {
          progress_percent: percent,
          status:           percent === 100 ? 'completed' : undefined,
          completed_at:     percent === 100 ? new Date()  : null,
        },
      },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, message: 'Task not found' });

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── HANDLE PERMISSION ────────────────────────────────────────────────────────

const handlePermission = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'grant' | 'deny'

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    if (!['grant', 'deny'].includes(action))
      return res.status(400).json({ success: false, message: 'action must be "grant" or "deny"' });

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
    if (task.permission_status !== 'pending')
      return res.status(400).json({ success: false, message: 'Task does not have a pending permission request' });

    const isGranting = action === 'grant';
    const updated = await Task.findByIdAndUpdate(
      id,
      {
        $set: {
          permission_status:     isGranting ? 'granted' : 'denied',
          permission_granted_by: req.user._id,
          permission_granted_at: new Date(),
          status:                isGranting ? 'todo' : 'cancelled',
        },
      },
      { new: true }
    );

    if (task.assigned_to) {
      await Notification.create({
        user_id:   task.assigned_to,
        sender_id: req.user._id,
        message:   `Permission for task "${task.title}" has been ${isGranting ? 'granted ✅' : 'denied ❌'}.`,
        type:      isGranting ? 'permission_granted' : 'permission_denied',
        ref_id:    task._id,
        ref_type:  'Task',
      }).catch(console.error);
    }

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── REQUEST PERMISSION ───────────────────────────────────────────────────────

const requestPermission = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    if (task.assigned_to?.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Only the assigned employee can request permission' });

    const updated = await Task.findByIdAndUpdate(
      id,
      {
        $set: {
          requires_permission:    true,
          permission_description: reason || task.permission_description,
          permission_status:      'pending',
          status:                 'blocked',
        },
      },
      { new: true }
    );

    return res.status(200).json({ success: true, data: updated, message: 'Permission requested' });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── REASSIGN ─────────────────────────────────────────────────────────────────

const reassignTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { to_user, reason, trigger = 'manual' } = req.body;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    if (!isValidObjectId(to_user))
      return res.status(400).json({ success: false, message: 'Invalid to_user' });

    const task = await Task.findById(id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const logEntry = {
      from_user:     task.assigned_to,
      to_user:       to_user,
      reason:        reason || null,
      reassigned_by: req.user._id,
      reassigned_at: new Date(),
      trigger,
    };

    const updated = await Task.findByIdAndUpdate(
      id,
      {
        $set: { assigned_to: to_user, status: 'todo' },
        $push: { reassign_logs: logEntry },
      },
      { new: true }
    ).populate('assigned_to', 'name email');

    await Notification.create({
      user_id:   to_user,
      sender_id: req.user._id,
      message:   `Task "${task.title}" has been reassigned to you.`,
      type:      'task_reassigned',
      ref_id:    task._id,
      ref_type:  'Task',
    }).catch(console.error);

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── STATS ────────────────────────────────────────────────────────────────────

const getTaskStats = async (req, res) => {
  try {
    // admin → all · manager → dept employees + own · employee → own
    const matchFilter = await buildTaskScope(req.user);

    const [byStatus, byPriority, delayed] = await Promise.all([
      Task.aggregate([{ $match: matchFilter }, { $group: { _id: '$status',   count: { $sum: 1 } } }]),
      Task.aggregate([{ $match: matchFilter }, { $group: { _id: '$priority', count: { $sum: 1 } } }]),
      Task.countDocuments({ ...matchFilter, is_delayed: true }),
    ]);

    const toMap = (arr) => arr.reduce((acc, { _id, count }) => ({ ...acc, [_id]: count }), {});

    return res.status(200).json({
      success: true,
      data: {
        by_status:   toMap(byStatus),
        by_priority: toMap(byPriority),
        delayed,
        total: await Task.countDocuments(matchFilter),
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── WORKLOAD OVERVIEW ────────────────────────────────────────────────────────

const getWorkloadOverview = async (req, res) => {
  try {
    const User = require('../models/users');
    const employees = await User.find({ role: 'employee', status: 'active' }).select('_id name designation department');

    const workloads = await Promise.all(
      employees.map(async (emp) => {
        const score = await getUserWorkloadScore(emp._id);
        return { ...emp.toObject(), workload_score: score };
      })
    );

    return res.status(200).json({ success: true, data: workloads });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── SUBTASK: ADD ─────────────────────────────────────────────────────────────

/**
 * POST /tasks/:id/subtasks
 * Body: { title, description?, assigned_to?, priority?, due_date? }
 */
const addSubtask = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });

    const { title, description, assigned_to, priority, due_date } = req.body;

    if (!title || !title.trim())
      return res.status(400).json({ success: false, message: 'Subtask title is required' });

    if (assigned_to && !isValidObjectId(assigned_to))
      return res.status(400).json({ success: false, message: 'Invalid assigned_to for subtask' });

    const subtaskDoc = {
      title:       title.trim(),
      description: description || null,
      assigned_to: assigned_to || null,
      priority:    priority    || 'medium',
      due_date:    due_date    || null,
    };

    const task = await Task.findByIdAndUpdate(
      id,
      { $push: { subtasks: subtaskDoc } },
      { new: true, runValidators: true }
    ).populate('subtasks.assigned_to', 'name email');

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    // Notify assignee
    if (assigned_to) {
      await Notification.create({
        user_id:   assigned_to,
        sender_id: req.user._id,
        message:   `You have been assigned a subtask: "${title}"`,
        type:      'task_assigned',
        ref_id:    task._id,
        ref_type:  'Task',
      }).catch(console.error);
    }

    return res.status(201).json({ success: true, data: task });
  } catch (error) {
    if (error.name === 'ValidationError')
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── SUBTASK: UPDATE ──────────────────────────────────────────────────────────

/**
 * PATCH /tasks/:id/subtasks/:subtaskId
 * Body: any subtask field(s) to update
 */
const updateSubtask = async (req, res) => {
  try {
    const { id, subtaskId } = req.params;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    if (!isValidObjectId(subtaskId))
      return res.status(400).json({ success: false, message: 'Invalid subtask ID' });

    const allowedFields = ['title', 'description', 'assigned_to', 'status', 'priority', 'due_date'];
    const setFields = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        setFields[`subtasks.$.${field}`] = req.body[field];
      }
    }

    if (req.body.status === 'completed') {
      setFields['subtasks.$.completed_at'] = new Date();
    }

    if (Object.keys(setFields).length === 0)
      return res.status(400).json({ success: false, message: 'No valid fields provided' });

    const task = await Task.findOneAndUpdate(
      { _id: id, 'subtasks._id': subtaskId },
      { $set: setFields },
      { new: true, runValidators: true }
    ).populate('subtasks.assigned_to', 'name email');

    if (!task) return res.status(404).json({ success: false, message: 'Task or subtask not found' });

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    if (error.name === 'ValidationError')
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── SUBTASK: DELETE ──────────────────────────────────────────────────────────

/**
 * DELETE /tasks/:id/subtasks/:subtaskId
 */
const deleteSubtask = async (req, res) => {
  try {
    const { id, subtaskId } = req.params;

    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid task ID' });
    if (!isValidObjectId(subtaskId))
      return res.status(400).json({ success: false, message: 'Invalid subtask ID' });

    const task = await Task.findByIdAndUpdate(
      id,
      { $pull: { subtasks: { _id: subtaskId } } },
      { new: true }
    );

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    return res.status(200).json({ success: true, message: 'Subtask deleted', data: task });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = {
  createTask,
  getAllTasks,
  getTaskById,
  updateTask,
  updateTaskStatus,   // NEW
  deleteTask,
  bulkUpdateStatus,
  logDelay,
  updateProgress,
  handlePermission,
  requestPermission,
  reassignTask,
  getTaskStats,
  getWorkloadOverview,
  addSubtask,         // NEW
  updateSubtask,      // NEW
  deleteSubtask,      // NEW
};