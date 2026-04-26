/**
 * routes/uploadRoutes.js
 * ─────────────────────────────────────────────────────────
 * PLACE AT: routes/uploadRoutes.js
 *
 * REGISTER IN routes/Index.js:
 *   const uploadRoutes = require('./uploadRoutes');
 *   router.use('/upload', uploadRoutes);
 *
 * ENDPOINTS:
 *   POST  /api/upload/excel/:projectId   — import Excel tasks (admin/manager)
 *   GET   /api/upload/template           — download blank template (any auth)
 *   GET   /api/upload/imports/:projectId — list imported tasks (admin/manager)
 */

const express = require('express');
const router  = express.Router();

const { protect, authorise }     = require('../middleware/authMiddleware');
const { uploadExcel }            = require('../middleware/excelUploadMiddleware');
const {
  importFromExcel,
  downloadTemplate,
  getImportedTasks,
} = require('../controllers/Uploadcontroller');

// Download template — any authenticated user can get it
router.get('/template', protect, downloadTemplate);

// Import Excel → auto-create & assign tasks
router.post(
  '/excel/:projectId',
  protect,
  authorise('admin', 'manager'),
  uploadExcel,               // multer: parses req.file from field "excel"
  importFromExcel
);

// List already-imported tasks for a project
router.get(
  '/imports/:projectId',
  protect,
  authorise('admin', 'manager'),
  getImportedTasks
);

module.exports = router;