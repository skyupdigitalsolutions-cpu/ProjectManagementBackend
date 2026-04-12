const express = require("express");
const router = express.Router();

const {
  createTask,
  getAllTasks,
  getTaskById,
  updateTask,
  deleteTask,
  bulkUpdateStatus,
  getTaskStats,
} = require("../controllers/taskController");
const { protect, authorise } = require("../middleware/authMiddleware");

// GET    /api/v1/tasks/stats          — Admin/Manager: counts per status (?project_id)
// POST   /api/v1/tasks/bulk-status    — Admin/Manager: update status for multiple tasks at once
// POST   /api/v1/tasks                — Admin/Manager: create a task
// GET    /api/v1/tasks                — Protected: list tasks (?project_id &assigned_to &status &priority &page &limit)
// GET    /api/v1/tasks/:id            — Protected: single task detail
// PATCH  /api/v1/tasks/:id            — Protected: update task (auto-manages completed_at)
// DELETE /api/v1/tasks/:id            — Admin/Manager: delete a task

// /stats and /bulk-status must come before /:id
router.get("/stats",         protect, authorise("admin", "manager"), getTaskStats);
router.post("/bulk-status",  protect, authorise("admin", "manager"), bulkUpdateStatus);
router.post("/",             protect, authorise("admin", "manager"), createTask);
router.get("/",              protect, getAllTasks);
router.get("/:id",           protect, getTaskById);
router.patch("/:id",         protect, updateTask);
router.delete("/:id",        protect, authorise("admin", "manager"), deleteTask);

module.exports = router;
