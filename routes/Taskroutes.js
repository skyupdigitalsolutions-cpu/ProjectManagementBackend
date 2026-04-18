const express = require("express");
const router  = express.Router();

const {
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
} = require("../controllers/taskController");
const { protect, authorise } = require("../middleware/authMiddleware");

// ── Utility / collection routes (must come before /:id) ───────────────────────
// GET    /api/v1/tasks/stats       — Admin/Manager: task counts per status
// GET    /api/v1/tasks/workload    — Admin/Manager: per-employee workload overview
// POST   /api/v1/tasks/bulk-status — Admin/Manager: update status for multiple tasks

router.get( "/stats",        protect, authorise("admin", "manager"), getTaskStats);
router.get( "/workload",     protect, authorise("admin", "manager"), getWorkloadOverview);
router.post("/bulk-status",  protect, authorise("admin", "manager"), bulkUpdateStatus);

// ── Main CRUD ─────────────────────────────────────────────────────────────────
// POST   /api/v1/tasks             — Admin/Manager: create task
// GET    /api/v1/tasks             — Protected: list tasks (supports filters)
// GET    /api/v1/tasks/:id         — Protected: single task with full history
// PATCH  /api/v1/tasks/:id         — Protected: update task fields
// DELETE /api/v1/tasks/:id         — Admin/Manager: delete task

router.post("/",    protect, authorise("admin", "manager"), createTask);
router.get( "/",    protect, getAllTasks);
router.get( "/:id", protect, getTaskById);
router.patch("/:id",protect, updateTask);
router.delete("/:id", protect, authorise("admin", "manager"), deleteTask);

// ── Progress tracking ─────────────────────────────────────────────────────────
// PATCH  /api/v1/tasks/:id/progress  — Assigned employee / Manager: update % done
router.patch("/:id/progress", protect, updateProgress);

// ── Delay logging ─────────────────────────────────────────────────────────────
// POST   /api/v1/tasks/:id/delay   — Assigned employee / Manager: log delay reason
router.post("/:id/delay", protect, logDelay);

// ── Permission handling ───────────────────────────────────────────────────────
// PATCH  /api/v1/tasks/:id/permission — Admin only: grant or deny access
router.patch("/:id/permission", protect, authorise("admin"), handlePermission);

// ── Manual reassignment ────────────────────────────────────────────────────────
// PATCH  /api/v1/tasks/:id/reassign — Admin/Manager: reassign to another employee
router.patch("/:id/reassign", protect, authorise("admin", "manager"), reassignTask);

module.exports = router;
