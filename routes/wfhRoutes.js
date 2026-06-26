/**
 * routes/wfhRoutes.js
 * Mount in Index.js as: router.use('/wfh', wfhRoutes)
 */

const express = require('express');
const router  = express.Router();
const {
  submitWfhRequest,
  getMyWfhRequests,
  getAllWfhRequests,
  updateWfhRequestStatus,
  setUserWorkModeOverride,
} = require('../controllers/wfhController');
const { protect, authorise } = require('../middleware/authMiddleware');

// ── Employee ──────────────────────────────────────────────────────────────────
router.post('/request',             protect, submitWfhRequest);
router.get('/my-requests',          protect, getMyWfhRequests);

// ── Admin / Manager ───────────────────────────────────────────────────────────
router.get('/requests',              protect, authorise('admin', 'manager'), getAllWfhRequests);
router.patch('/request/:id/status', protect, authorise('admin', 'manager'), updateWfhRequestStatus);
router.patch('/override/:user_id',  protect, authorise('admin'),            setUserWorkModeOverride);

module.exports = router;