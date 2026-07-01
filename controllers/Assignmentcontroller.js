const mongoose         = require("mongoose");
const Assignment       = require("../models/assignment");
const AssignmentMember = require("../models/assignment_member");
const Task             = require("../models/tasks");
const Project          = require("../models/project");
const ProjectMember    = require("../models/project_member");
const User             = require("../models/users");
const Notification     = require("../models/notification");
const {
  autoAssignProjectTasks,
  PROJECT_TYPE_ROLES,
} = require("../services/autoAssignService");
const { adaptiveAutoAssign } = require("../services/adaptiveAssignmentEngine");
const { interpretRequirements, flattenModulesToDrafts } = require("../services/requirementInterpreter");
const { scheduleTasks }                                  = require("../services/schedulingEngine");

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);
const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({
    success: false,
    message: error.message || "Internal server error",
  });
};

// ─── Fallback employee matcher ───────────────────────────────────────────────
// Used whenever a task/subtask reaches the server with no assignee (e.g. the
// wizard's optional "Auto-Assign Generated Tasks" panel wasn't run). Without
// this, tasks silently land as "Unassigned" even when a clearly-qualified
// person exists — e.g. a "backend developer" task with no literal Backend
// Developer on staff, but a "Full Stack Web Developer" who should get it.
//
// Matching order:
//   1. Designation contains any word from the required role (fuzzy — this is
//      what lets "Full Stack Web Developer" match "backend developer" or
//      "frontend developer" via the shared word "developer").
//   2. Round-robin among employees in the matching department.
//   3. Round-robin across every active employee (last resort, never leaves a
//      task unassigned if at least one employee exists).
const buildFallbackAssigner = (allEmployees) => {
  const deptRoundRobin = {};

  const deptMatches = (userDept, wantedDept) => {
    if (!userDept || !wantedDept) return false;
    const u = userDept.toLowerCase();
    const w = wantedDept.toLowerCase();
    if (u === w) return true;
    if (u.includes(w) || w.includes(u)) return true;
    const tokens = w.split(/[\s&,]+/).filter((t) => t.length > 2);
    return tokens.some((tok) => u.includes(tok));
  };

  return (roleHint, deptHint) => {
    const roleWords = (roleHint || "")
      .split(/[\/\s,]+/)
      .map((w) => w.toLowerCase().trim())
      .filter((w) => w.length > 2);

    if (roleWords.length > 0) {
      const byRole = allEmployees.find((u) =>
        roleWords.some((word) => u.designation?.toLowerCase().includes(word))
      );
      if (byRole) return byRole._id;
    }

    const deptEmps = allEmployees.filter((u) => deptMatches(u.department, deptHint));
    if (deptEmps.length > 0) {
      const key = deptHint || "__all__";
      deptRoundRobin[key] = ((deptRoundRobin[key] ?? -1) + 1) % deptEmps.length;
      return deptEmps[deptRoundRobin[key]]._id;
    }

    if (allEmployees.length > 0) {
      deptRoundRobin.__global__ = ((deptRoundRobin.__global__ ?? -1) + 1) % allEmployees.length;
      return allEmployees[deptRoundRobin.__global__]._id;
    }

    return null;
  };
};

// ─── AUTO-PLAN PREVIEW ───────────────────────────────────────────────────────

/**
 * POST /api/assignments/auto-plan-preview
 *
 * Returns a full plan (modules + scheduled tasks) WITHOUT saving anything.
 * The admin reviews this in the frontend before confirming.
 *
 * Body: { description, project_type, complexity, start_date }
 */
const autoplanPreview = async (req, res) => {
  try {
    const { description, project_type, complexity, start_date } = req.body;

    if (!description || !project_type || !start_date) {
      return res.status(400).json({
        success: false,
        message: "description, project_type, and start_date are required",
      });
    }

    // 1. Interpret description → modules
    const modules = interpretRequirements(description, project_type, complexity || "medium");

    // 2. Flatten to task drafts
    const taskDrafts = flattenModulesToDrafts(modules);

    // 3. Schedule tasks with day-wise dates (no DB hit — pure calculation)
    const scheduledDrafts = scheduleTasks(taskDrafts, start_date);

    // 4. For each task, find the best candidate (preview only — no assignment saved)
    const previewTasks = await Promise.all(
      scheduledDrafts.map(async (draft) => {
        let candidateUser = null;

        if (draft.required_role || draft.required_department) {
          const query = { status: "active", role: "employee" };
          if (draft.required_role)
            query.designation = { $regex: draft.required_role, $options: "i" };
          else if (draft.required_department)
            query.department = { $regex: draft.required_department, $options: "i" };

          const candidates = await User.find(query).select("name designation department");

          // Sort by current workload (count active tasks)
          const withLoad = await Promise.all(
            candidates.map(async (u) => {
              const count = await Task.countDocuments({
                assigned_to: u._id,
                status: { $in: ["todo", "in-progress", "on-hold"] },
              });
              return { user: u, count };
            })
          );
          withLoad.sort((a, b) => a.count - b.count);
          candidateUser = withLoad[0]?.user || null;
        }

        return {
          module_name:         draft.module_name,
          title:               draft.title,
          required_role:       draft.required_role,
          required_department: draft.required_department,
          priority:            draft.priority,
          estimated_days:      draft.estimated_days,
          start_date:          draft.start_date,
          end_date:            draft.end_date,
          suggested_assignee:  candidateUser
            ? { _id: candidateUser._id, name: candidateUser.name, designation: candidateUser.designation }
            : null,
        };
      })
    );

    // 5. Group preview by module for clean frontend display
    const groupedModules = modules.map((mod) => ({
      name:  mod.name,
      tasks: previewTasks.filter((t) => t.module_name === mod.name),
    }));

    return res.status(200).json({
      success: true,
      data: {
        total_modules: groupedModules.length,
        total_tasks:   previewTasks.length,
        modules:       groupedModules,
        flat_tasks:    previewTasks,
      },
    });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── WIZARD — Create full project ────────────────────────────────────────────

/**
 * POST /api/assignments/wizard
 *
 * Two modes:
 *
 * MODE A — auto_plan: true  (NEW: fully automatic from description)
 * ─────────────────────────
 * Body: {
 *   project: { title, description, project_type, complexity, priority, start_date, end_date, manager_id, client_info },
 *   auto_plan: true
 * }
 * → Interprets description → generates modules → creates tasks → assigns → schedules
 * → No manual assignments array needed
 *
 * MODE B — auto_assign: true  (existing: manual tasks, smart assignment)
 * ──────────────────────────
 * Body: {
 *   project: { ... },
 *   assignments: [ { department, title, tasks: [{ title, required_role, due_date, ... }] } ],
 *   auto_assign: true
 * }
 *
 * MODE C — fully manual  (existing)
 * ──────────────────────
 * Body: {
 *   project: { ... },
 *   assignments: [ { members: [...userIds], tasks: [{ assigned_to, ... }] } ]
 * }
 */
const createProjectWizard = async (req, res) => {
  let createdProjectId = null;

  try {
    const {
      project:     projectData,
      assignments: assignmentsData = [],
      auto_plan   = false,
      auto_assign = false,
    } = req.body;

    if (!projectData)
      return res.status(400).json({ success: false, message: "project data is required" });

    // ── 1. Create the project ────────────────────────────────────────────
    const project = await Project.create({
      ...projectData,
      manager_id: projectData.manager_id || req.user._id,
    });
    createdProjectId = project._id;

    // ── 2. Auto-enroll manager ───────────────────────────────────────────
    await ProjectMember.findOneAndUpdate(
      { project_id: project._id, user_id: project.manager_id },
      { project_id: project._id, user_id: project.manager_id, role_in_project: "manager" },
      { upsert: true, new: true }
    );

    // ════════════════════════════════════════════════════════════════════
    // MODE A: FULL AUTO-PLAN from description
    // ════════════════════════════════════════════════════════════════════
    if (auto_plan) {
      if (!projectData.description || !projectData.project_type || !projectData.start_date) {
        return res.status(400).json({
          success: false,
          message: "auto_plan requires: description, project_type, start_date",
        });
      }

      // Step 1: Interpret description → module list
      const modules = interpretRequirements(
        projectData.description,
        projectData.project_type,
        projectData.complexity || "medium"
      );

      // Step 2: Flatten to task drafts
      const rawDrafts = flattenModulesToDrafts(modules);

      // Step 3: Schedule (add start_date / end_date per role, parallel tracks)
      const scheduledDrafts = scheduleTasks(rawDrafts, projectData.start_date);

      // Step 4: Create one Assignment per module (for organisation)
      const moduleAssignmentMap = {};
      for (const mod of modules) {
        const modTasks = scheduledDrafts.filter((t) => t.module_name === mod.name);
        if (!modTasks.length) continue;

        const modStart = modTasks.reduce(
          (min, t) => (!min || t.start_date < min ? t.start_date : min), null
        );
        const modEnd = modTasks.reduce(
          (max, t) => (!max || t.end_date > max ? t.end_date : max), null
        );

        // Determine department from first task in module
        const dept = modTasks[0]?.required_department || "General";

        const assignment = await Assignment.create({
          project_id:  project._id,
          department:  dept,
          title:       mod.name,
          description: `Auto-generated module: ${mod.name}`,
          start_date:  modStart || projectData.start_date,
          end_date:    modEnd   || projectData.end_date,
          status:      "planning",
        });

        moduleAssignmentMap[mod.name] = assignment._id;
      }

      // Attach assignment_id to each draft
      const draftsWithAssignments = scheduledDrafts.map((draft) => ({
        ...draft,
        assignment_id: moduleAssignmentMap[draft.module_name] || null,
      }));

      // Step 5: Auto-assign using adaptive engine (4-case decision logic)
      const { tasks: createdTasks, summary } = await adaptiveAutoAssign(
        project,
        draftsWithAssignments,
        req.user._id
      );

      // Notify manager
      await Notification.create({
        user_id:   project.manager_id,
        sender_id: req.user._id,
        message:   `✅ Project "${project.title}" was auto-created with ${createdTasks.length} tasks across ${modules.length} modules.`,
        type:      "auto_assign",
        ref_id:    project._id,
        ref_type:  "Project",
      }).catch(console.error);

      return res.status(201).json({
        success: true,
        message: `Auto-plan complete: ${modules.length} modules, ${createdTasks.length} tasks created`,
        data: {
          project,
          modules_created:    modules.length,
          tasks_created:      createdTasks.length,
          tasks:              createdTasks,
          assignment_summary: summary,
          // summary shape: { case1: N, case2: N, case3: N, case4: N, total: N }
        },
      });
    }

    // ════════════════════════════════════════════════════════════════════
    // MODE B: MANUAL TASK DRAFTS + SMART AUTO-ASSIGN
    // ════════════════════════════════════════════════════════════════════
    if (auto_assign) {
      const roleMappings = PROJECT_TYPE_ROLES[project.project_type] || PROJECT_TYPE_ROLES.website;
      const allTaskDrafts = [];

      for (const aData of assignmentsData) {
        const { tasks = [], ...assignmentFields } = aData;

        const assignment = await Assignment.create({
          ...assignmentFields,
          title: assignmentFields.title?.trim() || `${project.title} — Tasks`,
          project_id: project._id,
        });

        for (const taskDraft of tasks) {
          if (!taskDraft.required_role && !taskDraft.required_department) {
            const roleEntry = roleMappings.find((r) =>
              taskDraft.title?.toLowerCase().includes(r.role.split(" ")[0])
            );
            if (roleEntry) {
              taskDraft.required_role       = roleEntry.role;
              taskDraft.required_department = roleEntry.department;
            }
          }
          taskDraft.assignment_id = assignment._id;
          allTaskDrafts.push(taskDraft);
        }
      }

      // Schedule if start_date available on project
      const toAssign = project.start_date
        ? scheduleTasks(allTaskDrafts, project.start_date)
        : allTaskDrafts;

      const createdTasks = await autoAssignProjectTasks(project, toAssign, req.user._id);

      return res.status(201).json({
        success: true,
        message: `Project created with ${createdTasks.length} auto-assigned task(s)`,
        data: { project, tasks: createdTasks },
      });
    }

    // ════════════════════════════════════════════════════════════════════
    // MODE C: FULLY MANUAL  (with fallback auto-assign for anything the
    // wizard sent up as unassigned — see buildFallbackAssigner above)
    // ════════════════════════════════════════════════════════════════════
    const createdAssignments = [];
    const PRIORITY_SCORE     = { critical: 100, high: 75, medium: 50, low: 25 };

    // Pre-load once — reused across every assignment/task/subtask below.
    const allActiveEmployees = await User.find({
      status: "active",
      role: { $in: ["employee", "manager"] },
    }).select("_id name designation department");
    const fallbackAssign = buildFallbackAssigner(allActiveEmployees);

    for (const aData of assignmentsData) {
      const { members = [], tasks = [], ...assignmentFields } = aData;
      const memberSet = new Set(members.map(String));

      const assignment = await Assignment.create({
        ...assignmentFields,
        title: assignmentFields.title?.trim() || `${project.title} — Assignment ${createdAssignments.length + 1}`,
        project_id: project._id,
      });

      // Resolve missing assignees BEFORE saving — a task/subtask that came in
      // with no assigned_to gets the best-matching active employee instead of
      // sitting as "Unassigned".
      for (const t of tasks) {
        if (!t.assigned_to) {
          const picked = fallbackAssign(t.required_role, assignmentFields.department);
          if (picked) {
            t.assigned_to = picked;
            memberSet.add(String(picked));
          }
        }
        for (const st of t.subtasks || []) {
          if (!st.assigned_to) {
            const picked = fallbackAssign(st.required_role || t.required_role, assignmentFields.department);
            if (picked) {
              st.assigned_to = picked;
              memberSet.add(String(picked));
            }
          }
        }
      }

      const memberIds = Array.from(memberSet);
      if (memberIds.length) {
        const memberDocs = memberIds.map((userId) => ({
          assignment_id: assignment._id,
          user_id: userId,
        }));
        await AssignmentMember.insertMany(memberDocs, { ordered: false }).catch((e) => {
          if (e.code !== 11000) throw e;
        });

        const projMemberDocs = memberIds.map((userId) => ({
          project_id:      project._id,
          user_id:         userId,
          role_in_project: "developer",
        }));
        await ProjectMember.insertMany(projMemberDocs, { ordered: false }).catch((e) => {
          if (e.code !== 11000) throw e;
        });
      }

      const taskDocs = tasks.map((t) => ({
        ...t,
        project_id:     project._id,
        assignment_id:  assignment._id,
        assigned_by:    req.user._id,
        priority_score: PRIORITY_SCORE[t.priority || "medium"] || 50,
        permission_status: t.requires_permission ? "pending" : "not_required",
        status:         t.requires_permission ? "blocked" : (t.status || "todo"),
      }));

      const createdTasks = taskDocs.length ? await Task.insertMany(taskDocs) : [];

      for (const task of createdTasks) {
        if (task.assigned_to) {
          await Notification.create({
            user_id:   task.assigned_to,
            sender_id: req.user._id,
            message:   `You have been assigned a new task: "${task.title}"`,
            type:      "task_assigned",
            ref_id:    task._id,
            ref_type:  "Task",
          }).catch(console.error);
        }
      }

      createdAssignments.push({
        assignment,
        memberCount: members.length,
        taskCount:   createdTasks.length,
      });
    }

    return res.status(201).json({
      success: true,
      message: `Project created with ${createdAssignments.length} assignment(s)`,
      data: { project, assignments: createdAssignments },
    });

  } catch (error) {
    // Rollback on failure
    if (createdProjectId) {
      await Promise.allSettled([
        Project.findByIdAndDelete(createdProjectId),
        ProjectMember.deleteMany({ project_id: createdProjectId }),
        Assignment.deleteMany({ project_id: createdProjectId }),
        Task.deleteMany({ project_id: createdProjectId }),
      ]);
    }
    console.error("Project Wizard Error:", error.message);
    if (error.name === "ValidationError" || error.message?.includes("end_date"))
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── SINGLE ASSIGNMENT CREATE ────────────────────────────────────────────────

const createAssignment = async (req, res) => {
  try {
    const { project_id } = req.body;
    if (!isValidObjectId(project_id))
      return res.status(400).json({ success: false, message: "Invalid project_id" });

    const assignment = await Assignment.create({ ...req.body });
    return res.status(201).json({ success: true, data: assignment });
  } catch (error) {
    if (error.name === "ValidationError")
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── GET ASSIGNMENTS ─────────────────────────────────────────────────────────

const getAssignments = async (req, res) => {
  try {
    const { project_id, status } = req.query;
    const filter = {};
    if (project_id) {
      if (!isValidObjectId(project_id))
        return res.status(400).json({ success: false, message: "Invalid project_id" });
      filter.project_id = project_id;
    }
    if (status) filter.status = status;

    const assignments = await Assignment.find(filter)
      .populate("project_id", "title status priority project_type")
      .sort({ createdAt: -1 });

    // Enrich with task counts AND members so the edit wizard can pre-populate team
    const ids = assignments.map(a => a._id);
    const [taskCounts, memberDocs] = await Promise.all([
      Task.aggregate([
        { $match: { assignment_id: { $in: ids } } },
        { $group: { _id: '$assignment_id', count: { $sum: 1 } } },
      ]),
      AssignmentMember.find({ assignment_id: { $in: ids } })
        .populate('user_id', 'name email department designation status'),
    ]);
    const countMap = Object.fromEntries(taskCounts.map(t => [t._id.toString(), t.count]));

    // Group members by assignment_id
    const memberMap = {};
    for (const m of memberDocs) {
      const aid = m.assignment_id.toString();
      if (!memberMap[aid]) memberMap[aid] = [];
      memberMap[aid].push(m);
    }

    const enriched = assignments.map(a => ({
      ...a.toObject(),
      task_count: countMap[a._id.toString()] ?? 0,
      members: memberMap[a._id.toString()] ?? [],
    }));

    return res.status(200).json({ success: true, data: enriched });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET SINGLE ASSIGNMENT ───────────────────────────────────────────────────

const getAssignmentById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid assignment ID" });

    const [assignment, members, tasks] = await Promise.all([
      Assignment.findById(id).populate("project_id", "title status priority project_type"),
      AssignmentMember.find({ assignment_id: id })
        .populate("user_id", "name email department designation status"),
      Task.find({ assignment_id: id })
        .populate("assigned_to", "name email department designation")
        .sort({ start_date: 1, priority_score: -1 }),
    ]);

    if (!assignment)
      return res.status(404).json({ success: false, message: "Assignment not found" });

    return res.status(200).json({ success: true, data: { assignment, members, tasks } });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── UPDATE ASSIGNMENT ────────────────────────────────────────────────────────

const updateAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid assignment ID" });

    const updates = { ...req.body };
    delete updates._id;
    delete updates.project_id;

    // Sync AssignmentMember collection when members array is provided
    if (Array.isArray(updates.members)) {
      await AssignmentMember.deleteMany({ assignment_id: id });
      if (updates.members.length > 0) {
        const docs = updates.members.map(uid => ({ assignment_id: id, user_id: uid }));
        await AssignmentMember.insertMany(docs, { ordered: false }).catch(e => {
          if (e.code !== 11000) throw e;
        });
      }
      delete updates.members; // Don't store raw array on Assignment document
    }

    const assignment = await Assignment.findByIdAndUpdate(
      id, { $set: updates }, { new: true, runValidators: true }
    );

    if (!assignment)
      return res.status(404).json({ success: false, message: "Assignment not found" });

    return res.status(200).json({ success: true, data: assignment });
  } catch (error) {
    if (error.name === "ValidationError")
      return res.status(400).json({ success: false, message: error.message });
    return handleError(res, error);
  }
};

// ─── DELETE ASSIGNMENT ────────────────────────────────────────────────────────

const deleteAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid assignment ID" });

    await Promise.all([
      Assignment.findByIdAndDelete(id),
      AssignmentMember.deleteMany({ assignment_id: id }),
      Task.deleteMany({ assignment_id: id }),
    ]);

    return res.status(200).json({ success: true, message: "Assignment deleted" });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── ADD / REMOVE MEMBER ─────────────────────────────────────────────────────

const addMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;
    if (!isValidObjectId(id) || !isValidObjectId(user_id))
      return res.status(400).json({ success: false, message: "Invalid IDs" });

    const assignment = await Assignment.findById(id);
    if (!assignment)
      return res.status(404).json({ success: false, message: "Assignment not found" });

    const member = await AssignmentMember.create({ assignment_id: id, user_id });
    return res.status(201).json({ success: true, data: member });
  } catch (error) {
    if (error.code === 11000)
      return res.status(409).json({ success: false, message: "Member already in assignment" });
    return handleError(res, error);
  }
};

const removeMember = async (req, res) => {
  try {
    const { id, user_id } = req.params;
    if (!isValidObjectId(id) || !isValidObjectId(user_id))
      return res.status(400).json({ success: false, message: "Invalid IDs" });

    await AssignmentMember.findOneAndDelete({ assignment_id: id, user_id });
    return res.status(200).json({ success: true, message: "Member removed" });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET ASSIGNMENT TASKS ─────────────────────────────────────────────────────

const getAssignmentTasks = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: "Invalid assignment ID" });

    const tasks = await Task.find({ assignment_id: id })
      .populate("assigned_to", "name email department designation status")
      .populate("assigned_by", "name email")
      .sort({ start_date: 1, priority_score: -1 });

    return res.status(200).json({ success: true, data: tasks });
  } catch (error) {
    return handleError(res, error);
  }
};

/**
 * POST /assignments/auto-assign-from-document
 *
 * Takes extracted task drafts returned by createProject (when a document was uploaded)
 * and runs the full auto-assign pipeline on them.
 *
 * Body: { project_id, tasks: [{ title, description, required_role, required_department, priority, estimated_days }] }
 */


 
const autoAssignFromDocument = async (req, res) => {
  try {
    const { project_id, tasks } = req.body;

    if (!project_id || !isValidObjectId(project_id)) {
      return res.status(400).json({ success: false, message: "Valid project_id is required" });
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ success: false, message: "tasks array is required and must not be empty" });
    }

    const project = await Project.findById(project_id);
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    const taggedDrafts = tasks.map(t => ({ ...t, _from_document: true }));
    const { tasks: createdTasks, summary } = await adaptiveAutoAssign(project, taggedDrafts, req.user._id.toString());

    return res.status(201).json({
      success: true,
      message: `${createdTasks.length} tasks processed from document`,
      data: createdTasks,
      assignment_summary: summary,
    });
  } catch (error) {
    return handleError(res, error);
  }
};

const autoAssignForProject = async (req, res) => {
  try {
    const { project_id } = req.params;

    if (!isValidObjectId(project_id))
      return res.status(400).json({ success: false, message: 'Invalid project_id' });

    const project = await Project.findById(project_id);
    if (!project)
      return res.status(404).json({ success: false, message: 'Project not found' });

    const { generateUnifiedProjectPlan } = require('../services/taskGenerationService');

    // Use project_types array first, fall back to single project_type
    const types = (project.project_types && project.project_types.length > 0)
      ? project.project_types
      : project.project_type
        ? [project.project_type]
        : ['other'];

    const plan = generateUnifiedProjectPlan(types, project.description || '');
    const phases = plan.phases || [];

    if (phases.length === 0) {
      return res.status(400).json({ success: false, message: 'No phases generated for the given project types' });
    }

    // ── Step 1: Wipe ALL existing assignments + tasks for this project ────────
    // We do a full reset so the regenerated plan is always clean
    const existingAssignments = await Assignment.find({ project_id }).select('_id');
    const assignmentIds = existingAssignments.map(a => a._id);

    await Promise.all([
      Task.deleteMany({ project_id }),
      AssignmentMember.deleteMany({ assignment_id: { $in: assignmentIds } }),
      Assignment.deleteMany({ project_id }),
    ]);

    // ── Step 2: Rebuild assignments + tasks from phases ───────────────────────
    // Map phase name → a sensible department label
    const phaseDeptMap = {
      'Planning': 'HR & Admin',
      'Design':   'Graphic Design',
      'Development': 'Web Design & Development',
      'Testing':  'Testing',
      'Marketing': 'Performance Marketing',
      'Optimization': 'SEO',
      'Launch':    'Web Design & Development',
      'Monitoring': 'Web Design & Development',
      'Content':    'Content Marketing',
      'Social':     'Social Media Marketing',
      'Analytics':  'Analytics & Reporting',
      'Email':      'Email Marketing',
    };

    const getDeptForPhase = (phaseName) => {
      for (const [key, dept] of Object.entries(phaseDeptMap)) {
        if (phaseName.includes(key)) return dept;
      }
      return 'General';
    };

    let totalTasks = 0;
    const createdPhases = [];

    // Pre-load ALL active employees once to avoid N+1 queries
    const allEmployees = await User.find({ status: 'active', role: 'employee' })
      .select('_id name designation department');

    // Helper: fuzzy dept match
    const deptMatchesUser = (userDept, assignmentDept) => {
      if (!userDept || !assignmentDept) return false;
      const u = userDept.toLowerCase();
      const a = assignmentDept.toLowerCase();
      if (u === a) return true;
      if (u.includes(a) || a.includes(u)) return true;
      const tokens = a.split(/[\s&,]+/).filter(t => t.length > 2);
      return tokens.some(tok => u.includes(tok));
    };

    // Round-robin counters per dept so tasks spread evenly across employees
    const deptRoundRobin = {};

    // Helper: pick best employee — designation match first, then round-robin within dept,
    // then any employee. NEVER falls back to admin.
    const pickEmployee = (roleHint, deptName) => {
      // Build role keywords — handle "UI/UX Designer" → ["UI", "UX", "Designer"]
      const roleWords = (roleHint || '')
        .split(/[\/\s,]+/)
        .map(w => w.toLowerCase().trim())
        .filter(w => w.length > 2);

      // 1. Designation match on any role word
      if (roleWords.length > 0) {
        const byRole = allEmployees.find(u =>
          roleWords.some(word => u.designation?.toLowerCase().includes(word))
        );
        if (byRole) return byRole._id;
      }

      // 2. Round-robin among employees in the same department
      const deptEmps = allEmployees.filter(u => deptMatchesUser(u.department, deptName));
      if (deptEmps.length > 0) {
        const key = deptName || '__all__';
        deptRoundRobin[key] = ((deptRoundRobin[key] ?? -1) + 1) % deptEmps.length;
        return deptEmps[deptRoundRobin[key]]._id;
      }

      // 3. Round-robin across ALL employees (project has employees from other depts)
      if (allEmployees.length > 0) {
        deptRoundRobin['__global__'] = ((deptRoundRobin['__global__'] ?? -1) + 1) % allEmployees.length;
        return allEmployees[deptRoundRobin['__global__']]._id;
      }

      // 4. Absolute last resort — no employees exist in the system at all
      return null;
    };

    for (const phase of phases) {
      const dept = getDeptForPhase(phase.name);

      const assignment = await Assignment.create({
        project_id,
        department:  dept,
        title:       phase.name,
        description: `Auto-generated: ${phase.name}`,
        start_date:  project.start_date,
        end_date:    project.end_date,
        status:      'planning',
      });

      // Build task docs, collecting unique assignee IDs for AssignmentMember
      const taskDocs = [];
      const memberIdSet = new Set();

     for (const t of (phase.tasks || [])) {
  const roleKeyword = (t.role || '').split('/')[0].trim();
  const employeeId  = pickEmployee(roleKeyword, dept);

  // Never fall back to admin — leave unassigned if no employee found
  if (!employeeId) {
    console.warn(`[autoAssignForProject] No employee found for role="${roleKeyword}" dept="${dept}". Task "${t.title}" will be unassigned.`);
  }

  taskDocs.push({
    project_id,
    assignment_id:    assignment._id,
    title:            t.title,
    description:      t.role || '',
    assigned_to:      employeeId || undefined,       // ← FIXED: no admin fallback
    assigned_by:      req.user._id,
    priority:         (t.priority || 'Medium').toLowerCase(),
    status:           employeeId ? 'todo' : 'unassigned',  // ← FIXED: mark clearly
    is_auto_assigned: true,
    due_date:         project.end_date,
  });

  if (employeeId) memberIdSet.add(employeeId.toString());
}

      if (taskDocs.length > 0) {
        await Task.insertMany(taskDocs);
        totalTasks += taskDocs.length;
      }

      // ── Create AssignmentMember records for every unique assignee ──────────
      // This is what the ProjectDetail view reads to show "Team Members"
      if (memberIdSet.size > 0) {
        const memberDocs = Array.from(memberIdSet).map(uid => ({
          assignment_id: assignment._id,
          user_id:       uid,
        }));
        await AssignmentMember.insertMany(memberDocs, { ordered: false }).catch(() => {});
      }

      // Also add all dept employees as members (so edit wizard shows checkboxes pre-filled)
      const deptLow = dept.toLowerCase();
      const deptTokens = deptLow.split(/[\s&,]+/).filter(t => t.length > 2);
      const deptEmployees = allEmployees.filter(u => {
        const uDept = u.department?.toLowerCase() || '';
        return uDept === deptLow ||
          uDept.includes(deptLow) ||
          deptLow.includes(uDept) ||
          deptTokens.some(tok => uDept.includes(tok));
      });

      if (deptEmployees.length > 0) {
        const extraMembers = deptEmployees
          .filter(u => !memberIdSet.has(u._id.toString()))
          .map(u => ({ assignment_id: assignment._id, user_id: u._id }));
        if (extraMembers.length > 0) {
          await AssignmentMember.insertMany(extraMembers, { ordered: false }).catch(() => {});
        }
      }

      createdPhases.push({ phase: phase.name, tasks: taskDocs.length, members: memberIdSet.size + deptEmployees.length });
    }

    return res.status(200).json({
      success: true,
      message: `Plan regenerated for types [${types.join(', ')}]: ${phases.length} phases, ${totalTasks} tasks`,
      data: { types, phases_count: phases.length, tasks_created: totalTasks, phases: createdPhases },
    });
  } catch (error) {
    console.error('autoAssignForProject error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  autoplanPreview,
  createProjectWizard,
  createAssignment,
  getAssignments,
  getAssignmentById,
  updateAssignment,
  deleteAssignment,
  addMember,
  removeMember,
  getAssignmentTasks,
  autoAssignFromDocument,
  autoAssignForProject,  // ← now defined above
};