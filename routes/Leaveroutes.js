const express = require("express");
const router = express.Router();

const {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  getLeaveById,
  updateLeaveStatus,
  cancelLeave,
} = require("../controllers/leaveController");

const { protect, authorise } = require("../middleware/authMiddleware");

// POST   /api/leaves            — Any auth user: submit a leave application
// GET    /api/leaves/my         — Any auth user: get own leave requests
// GET    /api/leaves            — Admin/Manager: get all leave requests (?status &role &user_id)
// GET    /api/leaves/:id        — Auth: admin/manager any, employee own only
// PATCH  /api/leaves/:id        — Admin/Manager: approve or reject
// DELETE /api/leaves/:id        — Employee: cancel own pending; Admin: cancel any

// ⚠️ /my must be registered before /:id to avoid Express treating "my" as an ID param
router.get("/my",    protect, getMyLeaves);
router.get("/",      protect, authorise("admin", "manager"), getAllLeaves);
router.get("/:id",   protect, getLeaveById);
router.post("/",     protect, applyLeave);
router.patch("/:id", protect, authorise("admin", "manager"), updateLeaveStatus);
router.delete("/:id",protect, cancelLeave);

module.exports = router;
