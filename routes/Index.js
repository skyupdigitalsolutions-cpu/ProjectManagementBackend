/**
 * routes/Index.js — MERGED
 * ─────────────────────────────────────────────────────────────────────────────
 * Combines:
 *  - All original core routes
 *  - clientRoutes  → /clients
 *  - importRoutes  → /import
 *  - uploadRoutes  → /upload
 *  - esslRoutes    → /essl  (eSSL Fingerprint Machine)
 *  - Updated route filenames: userRoutes, projectRoutes, taskRoutes
 */

const express = require('express');
const router  = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
const authRoutes         = require('./Authroutes');

// ── User / People ─────────────────────────────────────────────────────────────
const userRoutes         = require('./Userroutes');
const memberRoutes       = require('./Memberroutes');

// ── Attendance & eSSL ─────────────────────────────────────────────────────────
const attendanceRoutes   = require('./Attendanceroutes');
const esslRoutes         = require('./Esslroutes');       // eSSL Fingerprint Machine

// ── Projects & Tasks ──────────────────────────────────────────────────────────
const projectRoutes      = require('./Projectroutes');
const taskRoutes         = require('./Taskroutes');

// ── Clients & Import ──────────────────────────────────────────────────────────
const clientRoutes       = require('./clientRoutes');
const importRoutes       = require('./importRoutes');

// ── Communication ─────────────────────────────────────────────────────────────
const notificationRoutes = require('./Notificationroutes');
const meetingRoutes      = require('./Meetingroutes');
const emailRoutes        = require('./Emailroutes');

// ── Assignments & Reports ─────────────────────────────────────────────────────
const assignmentRoutes   = require('./Assignmentroutes');
const dailyReportRoutes  = require('./Dailyreportroutes');
const leaveRoutes        = require('./Leaveroutes');

// ── Uploads ───────────────────────────────────────────────────────────────────
const uploadRoutes       = require('./uploadRoutes');

// ── Mount routes ──────────────────────────────────────────────────────────────
router.use('/auth',          authRoutes);
router.use('/users',         userRoutes);
router.use('/members',       memberRoutes);
router.use('/attendance',    attendanceRoutes);
router.use('/essl',          esslRoutes);
router.use('/projects',      projectRoutes);
router.use('/tasks',         taskRoutes);
router.use('/clients',       clientRoutes);
router.use('/import',        importRoutes);
router.use('/notifications', notificationRoutes);
router.use('/meetings',      meetingRoutes);
router.use('/email',         emailRoutes);
router.use('/assignments',   assignmentRoutes);
router.use('/daily-reports', dailyReportRoutes);
router.use('/leaves',        leaveRoutes);
router.use('/upload',        uploadRoutes);

module.exports = router;