/**
 * routes/policyRoutes.js
 * Mount in Index.js as: router.use('/policy', policyRoutes)
 */

const express = require('express');
const router  = express.Router();
const {
  getActivePolicy,
  getAllPolicies,
  createPolicy,
  updatePolicy,
  addHoliday,
  removeHoliday,
} = require('../controllers/policyController');
const { protect, authorise } = require('../middleware/authMiddleware');

// ── All authenticated users ───────────────────────────────────────────────────
router.get('/', protect, getActivePolicy);

// ── Admin only ────────────────────────────────────────────────────────────────
router.get('/all',               protect, authorise('admin'), getAllPolicies);
router.post('/',                 protect, authorise('admin'), createPolicy);
router.patch('/:id',             protect, authorise('admin'), updatePolicy);
router.post('/holidays',         protect, authorise('admin'), addHoliday);
router.delete('/holidays/:date', protect, authorise('admin'), removeHoliday);

module.exports = router;