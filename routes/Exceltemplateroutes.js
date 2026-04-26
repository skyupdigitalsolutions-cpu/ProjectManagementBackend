/**
 * routes/excelTemplateRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes for the globally-stored Excel template.
 *
 * REGISTER IN your routes index (e.g. routes/index.js or server.js):
 *   const excelTemplateRoutes = require('./excelTemplateRoutes');
 *   router.use('/excel-template', excelTemplateRoutes);
 *   // or if you mount directly on app:
 *   app.use('/api/excel-template', excelTemplateRoutes);
 *
 * ENDPOINTS:
 *   POST /api/excel-template        — upload / replace the global template
 *   GET  /api/excel-template        — get template metadata
 *   GET  /api/excel-template/tasks  — parse & return task rows
 */

const express = require('express')
const router  = express.Router()

const { protect, authorise }  = require('../middleware/authMiddleware')
const { uploadExcel }         = require('../middleware/excelUploadMiddleware')
const {
  uploadTemplate,
  getTemplate,
  getTemplateTasks,
} = require('../controllers/Exceltemplatecontroller')

// ── GET /api/excel-template ───────────────────────────────────────────────────
// Any authenticated user can check if a template exists.
router.get('/', protect, getTemplate)

// ── GET /api/excel-template/tasks ─────────────────────────────────────────────
// Parse the stored template and return task rows.
// Must come BEFORE the param route to avoid being swallowed.
router.get('/tasks', protect, getTemplateTasks)

// ── POST /api/excel-template ──────────────────────────────────────────────────
// Upload or replace the global template. Admin only.
// Reuses the existing excelUploadMiddleware but accepts field name "file"
// (the frontend ExcelImportModal sends fd.append('file', excelFile)).
router.post(
  '/',
  protect,
  authorise('admin'),
  (req, res, next) => {
    // The existing uploadExcel middleware expects field name "excel".
    // Our modal sends field name "file". We handle both by trying "file" first.
    const multer  = require('multer')
    const path    = require('path')
    const fs      = require('fs')

    const EXCEL_DIR = path.join(__dirname, '../uploads/excel')
    if (!fs.existsSync(EXCEL_DIR)) fs.mkdirSync(EXCEL_DIR, { recursive: true })

    const ALLOWED_MIMES = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream',
      'text/csv',
    ]
    const ALLOWED_EXTS = ['.xlsx', '.xls', '.csv']

    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, EXCEL_DIR),
      filename:    (_req, file, cb) => {
        const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`
        const ext   = path.extname(file.originalname).toLowerCase()
        cb(null, `global-template-${stamp}${ext}`)
      },
    })

    const fileFilter = (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      if (!ALLOWED_EXTS.includes(ext)) {
        return cb(new Error(`Only .xlsx, .xls, .csv files are allowed. Got: ${ext}`), false)
      }
      if (!ALLOWED_MIMES.includes(file.mimetype)) {
        // Some browsers send application/octet-stream for csv; be lenient
        if (!file.mimetype.includes('spreadsheet') && !file.mimetype.includes('excel') && file.mimetype !== 'text/csv') {
          return cb(new Error(`Unexpected MIME type: ${file.mimetype}`), false)
        }
      }
      cb(null, true)
    }

    const upload = multer({
      storage,
      fileFilter,
      limits: { fileSize: 20 * 1024 * 1024, files: 1 }, // 20 MB for global template
    }).single('file')  // ← field name "file" matches frontend FormData

    upload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE')
          return res.status(400).json({ success: false, message: 'File must be under 20 MB.' })
        return res.status(400).json({ success: false, message: `Upload error: ${err.message}` })
      }
      if (err) return res.status(400).json({ success: false, message: err.message })
      if (!req.file)
        return res.status(400).json({ success: false, message: 'No file received. Ensure field name is "file".' })
      next()
    })
  },
  uploadTemplate
)

module.exports = router