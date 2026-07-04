/**
 * routes/taskTemplateRoutes.js
 * Mounted at /api/task-templates (see routes/Index.js)
 *
 * All routes require an authenticated admin or manager.
 */

const express = require("express");
const router = express.Router();

const { protect, authorise } = require("../middleware/authMiddleware");
const {
  listTemplates,
  getTemplate,
  getTemplateForProject,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} = require("../controllers/taskTemplateController");

router.use(protect, authorise("admin", "manager"));

router.get("/", listTemplates);
// Must come BEFORE "/:id" so "for-project" isn't captured as an id.
router.get("/for-project", getTemplateForProject);
router.get("/:id", getTemplate);
router.post("/", createTemplate);
router.put("/:id", updateTemplate);
router.delete("/:id", deleteTemplate);

module.exports = router;