const express = require("express");
const router = express.Router();

const { getAllUsers, getUserById, updateUser, deleteUser, updateRole, getUserStats } = require("../controllers/userController");
const { protect, authorise } = require("../middleware/authMiddleware");

// GET    /api/v1/users/stats         — Admin only: counts by role, status, department
// GET    /api/v1/users               — Admin/Manager: list all users with filters
// GET    /api/v1/users/:id           — Protected: admin/manager sees any, employee sees own
// PATCH  /api/v1/users/:id/role      — Admin only: change a user's system role
// PATCH  /api/v1/users/:id           — Protected: admin/manager can edit all fields, employee edits own basic fields
// DELETE /api/v1/users/:id           — Admin only: soft-deactivates the account

// /stats must be registered before /:id to avoid Express treating "stats" as an ID
router.get("/stats",        protect, authorise("admin"), getUserStats);
router.get("/",             protect, authorise("admin", "manager"), getAllUsers);
router.get("/:id",          protect, getUserById);
router.patch("/:id/role",   protect, authorise("admin"), updateRole);
router.patch("/:id",        protect, updateUser);
router.delete("/:id",       protect, authorise("admin"), deleteUser);

module.exports = router;
