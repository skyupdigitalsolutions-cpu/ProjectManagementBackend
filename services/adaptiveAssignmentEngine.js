const Task         = require("../models/tasks");
const User         = require("../models/users");
const Leave        = require("../models/leave");
const Notification = require("../models/notification");
const ProjectMember = require("../models/project_member");
const { addWorkingDays, nextWorkingDay, scheduleTasksWithWorkload, getUserRoleEndDates } = require("./schedulingEngine");

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIORITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };

const WORKLOAD_DEADLINE_MULTIPLIER = {
  1: 1.0,
  2: 1.4,
  3: 1.8,
};

const MAX_ACTIVE_TASKS = 5;

// ─── STEP 1: Filter eligible employees for a role ─────────────────────────────

// NOTE: previously this used Mongo `$regex` with the raw required_role /
// required_department string as the pattern — that requires the LITERAL
// phrase (e.g. "backend developer") to appear inside the employee's
// designation, and the literal phrase "Web Development" to appear inside
// their department. Real-world data rarely matches that exactly — e.g. a
// designation of "Full Stack Web Developer" does not contain the substring
// "backend developer" anywhere, and a department of "IT" does not contain
// "Web Development" — so tasks were being marked "no eligible employee" and
// left unassigned even when an obviously-qualified person existed. Fixed to
// do word-overlap matching instead (same approach used by the frontend's
// auto-assign panel and the round-robin fallback in Assignmentcontroller.js).
async function getEligibleEmployees(required_role, required_department, taskStartDate) {
  const checkDate = taskStartDate ? new Date(taskStartDate) : new Date();

  const wordsOf = (str = "") =>
    String(str).toLowerCase().split(/[\s/\-_,]+/).filter((w) => w.length > 2);

  const roleWords = wordsOf(required_role);
  const deptWords  = wordsOf(required_department);

  // All active employees — filtering happens in JS below since fuzzy
  // word-overlap isn't expressible as a single simple Mongo regex.
  const candidates = await User.find({ role: "employee", status: "active" }).select(
    "_id name designation department status"
  );

  const matched = candidates.filter((u) => {
    const desig = (u.designation || "").toLowerCase();
    const dept  = (u.department  || "").toLowerCase();

    const designationMatch = roleWords.length > 0 && roleWords.some((w) => desig.includes(w));
    const departmentMatch  = deptWords.length  > 0 && deptWords.some((w) => dept.includes(w));

    return designationMatch || departmentMatch;
  });

  const available = await Promise.all(
    matched.map(async (u) => {
      const onLeave = await Leave.findOne({
        user_id:   u._id,
        status:    "approved",
        from_date: { $lte: checkDate },
        to_date:   { $gte: checkDate },
      });
      return onLeave ? null : u;
    })
  );

  return available.filter(Boolean);
}

// ─── STEP 2: Score and rank employees by workload ─────────────────────────────

async function rankByWorkload(employees) {
  const scored = await Promise.all(
    employees.map(async (u) => {
      const activeTasks = await Task.find({
        assigned_to: u._id,
        status: { $in: ["todo", "in-progress", "on-hold"] },
      }).select("priority");

      const workloadScore   = activeTasks.reduce((s, t) => s + (PRIORITY_SCORE[t.priority] || 0), 0);
      const activeTaskCount = activeTasks.length;

      return { ...u.toObject(), workloadScore, activeTaskCount };
    })
  );

  return scored.sort((a, b) =>
    a.workloadScore - b.workloadScore || a.activeTaskCount - b.activeTaskCount
  );
}

// ─── CORE FUNCTION: assignEmployeesToTask ─────────────────────────────────────

async function assignEmployeesToTask(task, employees) {
  const ideal        = task.required_employee_count || 1;
  const available    = employees.length;
  const startDate    = task.start_date ? new Date(task.start_date) : new Date();
  const baseDays     = task.estimated_days || 1;

  // ── CASE 4: No eligible employees ──────────────────────────────────────────
  if (available === 0) {
    return {
      case:                    4,
      assigned_employees:      [],
      primary_assignee:        null,
      workload_ratio:          0,
      adjusted_estimated_days: baseDays,
      adjusted_end_date:       addWorkingDays(startDate, baseDays),
      adjusted_due_date:       addWorkingDays(startDate, baseDays),
      availability_status:     "unassigned",
      decision_reason:         `No eligible employee found for role "${task.required_role || task.required_department}". Task marked unassigned.`,
    };
  }

  const ranked = await rankByWorkload(employees);

  // ── CASE 1: Exact match or more than enough employees ─────────────────────
  if (available >= ideal) {
    const assigned = ranked.slice(0, ideal);

    return {
      case:                    1,
      assigned_employees:      assigned,
      primary_assignee:        assigned[0],
      workload_ratio:          1.0,
      adjusted_estimated_days: baseDays,
      adjusted_end_date:       addWorkingDays(startDate, baseDays),
      adjusted_due_date:       addWorkingDays(startDate, baseDays),
      availability_status:     available > ideal ? "overstaffed" : "fully_staffed",
      decision_reason:         available > ideal
        ? `${available} employees available, ${ideal} needed. Assigned optimal ${ideal} (lightest workload).`
        : `Exact match: ${ideal} employee(s) assigned as per template.`,
    };
  }

  // ── CASE 2: Fewer employees than ideal — distribute and adjust deadline ────
  const assigned = ranked;

  const overloadRatio  = ideal / available;
  const multiplierKey  = Math.min(available, 3);
  const baseMultiplier = WORKLOAD_DEADLINE_MULTIPLIER[multiplierKey] || 1.8;
  const finalMultiplier = Math.max(baseMultiplier, overloadRatio * 0.9);

  const adjustedDays    = Math.ceil(baseDays * finalMultiplier);
  const adjustedEndDate = addWorkingDays(startDate, adjustedDays);

  return {
    case:                    2,
    assigned_employees:      assigned,
    primary_assignee:        assigned[0],
    workload_ratio:          available / ideal,
    adjusted_estimated_days: adjustedDays,
    adjusted_end_date:       adjustedEndDate,
    adjusted_due_date:       adjustedEndDate,
    availability_status:     "understaffed",
    decision_reason:         `Only ${available}/${ideal} employees available. Deadline extended from ${baseDays} to ${adjustedDays} days. Workload ratio: ${(available/ideal).toFixed(2)}.`,
  };
}

// ─── BATCH ASSIGNMENT: process all task drafts for a project ─────────────────

async function adaptiveAutoAssign(project, taskDrafts, assignedById) {
  const createdTasks   = [];
  const summary        = { case1: 0, case2: 0, case3: 0, case4: 0, total: 0 };
  const adminNotifs    = [];

  for (const draft of taskDrafts) {
    // ── 1. Get eligible employees for this role ───────────────────────────
    const eligible = await getEligibleEmployees(
      draft.required_role,
      draft.required_department,
      draft.start_date
    );

    // ── 2. Run decision engine ────────────────────────────────────────────
    const decision = await assignEmployeesToTask(draft, eligible);
    summary[`case${decision.case}`]++;
    summary.total++;

    // ── 3. CASE 4 — create unassigned task and notify admin ───────────────
    if (decision.case === 4) {
      const task = await Task.create({
        project_id:              project._id,
        assignment_id:           draft.assignment_id || null,
        title:                   draft.title,
        description:             draft.description || null,
        module_name:             draft.module_name || null,
        assigned_to:             null,
        assigned_by:             assignedById,
        status:                  "blocked",
        priority:                draft.priority || "medium",
        priority_score:          PRIORITY_SCORE[draft.priority || "medium"] || 50,
        start_date:              draft.start_date,
        end_date:                decision.adjusted_end_date,
        due_date:                decision.adjusted_due_date,
        estimated_days:          draft.estimated_days || 1,
        is_auto_assigned:        true,
        auto_assign_reason:      decision.decision_reason,
        required_role:           draft.required_role,
        required_department:     draft.required_department,
        required_employee_count: draft.required_employee_count || 1,
        assigned_employee_count: 0,
        workload_ratio:          0,
        availability_status:     "unassigned",
      });

      createdTasks.push(task);

      adminNotifs.push({
        user_id:   assignedById,
        sender_id: null,
        message:   `⚠️ Task "${task.title}" could not be auto-assigned — no eligible employee for role "${draft.required_role || draft.required_department}". Manual assignment required.`,
        type:      "auto_assign",
        ref_id:    task._id,
        ref_type:  "Task",
      });

      continue;
    }

    // ── 4. CASES 1, 2 — create one Task per assigned employee ────────────
    const assigneesForTask = decision.assigned_employees;

    for (let i = 0; i < assigneesForTask.length; i++) {
      const assignee = assigneesForTask[i];

      const taskTitle = assigneesForTask.length > 1
        ? `${draft.title} [${assignee.name}]`
        : draft.title;

      const existingTasks = await Task.find({
        assigned_to:   assignee._id,
        required_role: draft.required_role,
        status: { $in: ["todo", "in-progress", "on-hold"] },
      }).select("end_date required_role");

      const existingWorkload = getUserRoleEndDates(existingTasks);

      const [rescheduled] = scheduleTasksWithWorkload(
        [{ ...draft, estimated_days: decision.adjusted_estimated_days }],
        project.start_date,
        existingWorkload
      );

      const task = await Task.create({
        project_id:              project._id,
        assignment_id:           draft.assignment_id || null,
        title:                   taskTitle,
        description:             draft.description || null,
        module_name:             draft.module_name || null,
        assigned_to:             assignee._id,
        assigned_by:             assignedById,
        status:                  "todo",
        priority:                draft.priority || "medium",
        priority_score:          PRIORITY_SCORE[draft.priority || "medium"] || 50,
        start_date:              rescheduled.start_date,
        end_date:                rescheduled.end_date,
        due_date:                rescheduled.due_date,
        estimated_days:          decision.adjusted_estimated_days,
        is_auto_assigned:        true,
        auto_assign_reason:      `[CASE ${decision.case}] ${decision.decision_reason}`,
        required_role:           draft.required_role,
        required_department:     draft.required_department,
        required_employee_count: draft.required_employee_count || 1,
        assigned_employee_count: assigneesForTask.length,
        workload_ratio:          decision.workload_ratio,
        availability_status:     decision.availability_status,
      });

      createdTasks.push(task);

      await ProjectMember.findOneAndUpdate(
        { project_id: project._id, user_id: assignee._id },
        { project_id: project._id, user_id: assignee._id, role_in_project: "developer" },
        { upsert: true, new: true }
      ).catch(() => {});

      await Notification.create({
        user_id:   assignee._id,
        sender_id: assignedById,
        message:   `[Auto-Assigned] Task "${task.title}" assigned to you. Starts: ${rescheduled.start_date ? new Date(rescheduled.start_date).toDateString() : "TBD"}, Due: ${rescheduled.due_date ? new Date(rescheduled.due_date).toDateString() : "TBD"}.${decision.case === 2 ? ` Note: deadline extended due to understaffing (${decision.workload_ratio.toFixed(2)} staffing ratio).` : ""}`,
        type:      "auto_assign",
        ref_id:    task._id,
        ref_type:  "Task",
      }).catch(console.error);
    }

    if (decision.case === 2) {
      adminNotifs.push({
        user_id:   assignedById,
        sender_id: null,
        message:   `⚠️ Task "${draft.title}": Only ${decision.assigned_employees.length}/${draft.required_employee_count || 1} employees available. Deadline extended. Staffing ratio: ${decision.workload_ratio.toFixed(2)}.`,
        type:      "auto_assign",
        ref_id:    createdTasks[createdTasks.length - 1]?._id,
        ref_type:  "Task",
      });
    }
  }

  if (adminNotifs.length) {
    await Notification.insertMany(adminNotifs).catch(console.error);
  }

  return { tasks: createdTasks, summary };
}

module.exports = {
  adaptiveAutoAssign,
  assignEmployeesToTask,
  getEligibleEmployees,
  rankByWorkload,
};