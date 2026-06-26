const express = require("express");
const router = express.Router();
const multer = require("multer");

const {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  getLeaveById,
  updateLeaveStatus,
  cancelLeave,
} = require("../controllers/leaveController");

const { protect, authorise } = require("../middleware/authMiddleware");

// ── Multipart parser ──────────────────────────────────────────────────────────
// A leave request can include supporting documents (medical certificate, etc.),
// so the POST route receives multipart/form-data. Without this parser, req.body
// would be undefined and applyLeave would crash. memoryStorage is fine while the
// files are not being persisted to disk yet.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

router.get("/my",     protect, getMyLeaves);
router.get("/",       protect, authorise("admin", "manager"), getAllLeaves);
router.get("/:id",    protect, getLeaveById);

// upload.array("documents", 5) matches the frontend's fd.append('documents', f).
// It populates req.body (text fields) and req.files (uploaded files).
router.post("/",      protect, upload.array("documents", 5), applyLeave);

router.patch("/:id",  protect, authorise("admin", "manager"), updateLeaveStatus);
router.delete("/:id", protect, cancelLeave);

module.exports = router;