const mongoose = require("mongoose");
const ProjectMember = require("../models/project_member");
const Project = require("../models/project");
const Notification = require("../models/notification");

// ─── Helpers ────────────────────────────────────────────────────────────────

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const handleError = (res, error, statusCode = 500) => {
  console.error(error);
  return res.status(statusCode).json({ success: false, message: error.message || "Internal server error" });
};

/**
 * Checks whether the requesting user is an admin
 * or the manager of the target project.
 */
const canManageProject = async (projectId, user) => {
  if (user.role === "admin") return true;
  const project = await Project.findById(projectId).select("manager_id");
  return project && project.manager_id.toString() === user._id.toString();
};

// ─── ADD MEMBER ──────────────────────────────────────────────────────────────

const addMember = async (req, res) => {
  try {
    const { project_id } = req.params;
    const { user_id, role_in_project } = req.body;

    if (!isValidObjectId(project_id)) {
      return res.status(400).json({ success: false, message: "Invalid project ID" });
    }
    if (!isValidObjectId(user_id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    if (!(await canManageProject(project_id, req.user))) {
      return res.status(403).json({ success: false, message: "Not authorised to manage this project" });
    }

    // Check if member was previously removed — reactivate instead of creating duplicate
    const existing = await ProjectMember.findOne({ project_id, user_id });

    let member;
    if (existing) {
      if (existing.status === "active") {
        return res.status(400).json({ success: false, message: "User is already an active member of this project" });
      }
      // Reactivate
      existing.status = "active";
      existing.role_in_project = role_in_project || existing.role_in_project;
      existing.joined_at = new Date();
      member = await existing.save();
    } else {
      member = await ProjectMember.create({ project_id, user_id, role_in_project });
    }

    // Notify the added user
    await Notification.create({
      user_id,
      message: `You have been added to a project`,
      type: "project_assigned",
      ref_id: project_id,
      ref_type: "Project",
    });

    const populated = await member.populate("user_id", "name email designation");

    return res.status(201).json({ success: true, data: populated });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "User is already a member of this project" });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return handleError(res, error);
  }
};

// ─── GET MEMBERS ─────────────────────────────────────────────────────────────

/**
 * GET /projects/:project_id/members
 * Any authenticated member of the project (or admin/manager) can list members.
 * Query: ?status=active|removed|left &role_in_project=
 */
const getMembers = async (req, res) => {
  try {
    const { project_id } = req.params;
    const { status = "active", role_in_project } = req.query;

    if (!isValidObjectId(project_id)) {
      return res.status(400).json({ success: false, message: "Invalid project ID" });
    }

    const filter = { project_id };
    if (status) filter.status = status;
    if (role_in_project) filter.role_in_project = role_in_project;

    const members = await ProjectMember.find(filter)
      .populate("user_id", "name email designation department status")
      .sort({ joined_at: 1 });

    return res.status(200).json({ success: true, total: members.length, data: members });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── UPDATE MEMBER ROLE ──────────────────────────────────────────────────────

/**
 * PATCH /projects/:project_id/members/:member_id
 * Admin or project manager — change a member's role_in_project.
 */
const updateMemberRole = async (req, res) => {
  try {
    const { project_id, member_id } = req.params;
    const { role_in_project } = req.body;

    if (!isValidObjectId(project_id) || !isValidObjectId(member_id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    if (!(await canManageProject(project_id, req.user))) {
      return res.status(403).json({ success: false, message: "Not authorised to manage this project" });
    }

    const validRoles = ["manager", "developer", "designer", "tester", "viewer"];
    if (!validRoles.includes(role_in_project)) {
      return res.status(400).json({ success: false, message: `role_in_project must be one of: ${validRoles.join(", ")}` });
    }

    const member = await ProjectMember.findOneAndUpdate(
      { _id: member_id, project_id },
      { $set: { role_in_project } },
      { new: true }
    ).populate("user_id", "name email");

    if (!member) {
      return res.status(404).json({ success: false, message: "Member not found in this project" });
    }

    return res.status(200).json({ success: true, data: member });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── REMOVE MEMBER ───────────────────────────────────────────────────────────

/**
 * DELETE /projects/:project_id/members/:member_id
 * Admin or project manager — soft-removes by setting status to "removed".
 * Fires a "member_removed" notification.
 */
const removeMember = async (req, res) => {
  try {
    const { project_id, member_id } = req.params;

    if (!isValidObjectId(project_id) || !isValidObjectId(member_id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    if (!(await canManageProject(project_id, req.user))) {
      return res.status(403).json({ success: false, message: "Not authorised to manage this project" });
    }

    const member = await ProjectMember.findOneAndUpdate(
      { _id: member_id, project_id, status: "active" },
      { $set: { status: "removed" } },
      { new: true }
    );

    if (!member) {
      return res.status(404).json({ success: false, message: "Active member not found in this project" });
    }

    // Notify the removed member
    await Notification.create({
      user_id: member.user_id,
      message: `You have been removed from a project`,
      type: "member_removed",
      ref_id: project_id,
      ref_type: "Project",
    });

    return res.status(200).json({ success: true, message: "Member removed from project" });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── LEAVE PROJECT ───────────────────────────────────────────────────────────

/**
 * PATCH /projects/:project_id/members/leave
 * Any active member can leave a project themselves.
 */
const leaveProject = async (req, res) => {
  try {
    const { project_id } = req.params;

    if (!isValidObjectId(project_id)) {
      return res.status(400).json({ success: false, message: "Invalid project ID" });
    }

    const member = await ProjectMember.findOneAndUpdate(
      { project_id, user_id: req.user._id, status: "active" },
      { $set: { status: "left" } },
      { new: true }
    );

    if (!member) {
      return res.status(404).json({ success: false, message: "You are not an active member of this project" });
    }

    return res.status(200).json({ success: true, message: "You have left the project" });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── GET MY PROJECTS ─────────────────────────────────────────────────────────

/**
 * GET /members/my-projects
 * Returns all active projects the calling user belongs to.
 */
const getMyProjects = async (req, res) => {
  try {
    const memberships = await ProjectMember.find({
      user_id: req.user._id,
      status: "active",
    })
      .populate({
        path: "project_id",
        populate: { path: "manager_id", select: "name email" },
      })
      .sort({ joined_at: -1 });

    const projects = memberships
      .map((m) => ({ ...m.project_id?.toObject(), role_in_project: m.role_in_project, joined_at: m.joined_at }))
      .filter(Boolean);

    return res.status(200).json({ success: true, total: projects.length, data: projects });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = { addMember, getMembers, updateMemberRole, removeMember, leaveProject, getMyProjects };