const express = require("express");
const router  = express.Router();
const {
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
} = require("../controllers/Assignmentcontroller");
const { protect, authorise } = require("../middleware/authMiddleware");

// ── Auto-plan preview (no data saved — just returns the generated plan) ────────
// POST /api/assignments/auto-plan-preview
router.post(
  "/auto-plan-preview",
  protect,
  authorise("admin", "manager"),
  autoplanPreview
);

// ── Full project wizard (auto_plan | auto_assign | manual) ────────────────────
// POST /api/assignments/wizard
router.post(
  "/wizard",
  protect,
  authorise("admin", "manager"),
  createProjectWizard
);

// ── Single assignment CRUD ────────────────────────────────────────────────────
router.post("/",      protect, authorise("admin", "manager"), createAssignment);
router.get("/",       protect, getAssignments);
router.get("/:id",    protect, getAssignmentById);
router.patch("/:id",  protect, authorise("admin", "manager"), updateAssignment);
router.delete("/:id", protect, authorise("admin", "manager"), deleteAssignment);

// ── Assignment members ─────────────────────────────────────────────────────────
router.post("/:id/members",            protect, authorise("admin", "manager"), addMember);
router.delete("/:id/members/:user_id", protect, authorise("admin", "manager"), removeMember);

// ── Assignment tasks ──────────────────────────────────────────────────────────
router.get("/:id/tasks", protect, getAssignmentTasks);

module.exports = router;
