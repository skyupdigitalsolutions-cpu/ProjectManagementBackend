/**
 * services/Cronscheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANGES:
 *  - Removed nodemailer entirely
 *  - Email now sent via @getbrevo/brevo SDK (same as emailController.js)
 *
 * ENV VARS REQUIRED:
 *   BREVO_API_KEY    — from Brevo dashboard → SMTP & API → API Keys
 *   BREVO_FROM_EMAIL — verified sender email in your Brevo account
 *   BREVO_FROM_NAME  — sender display name (optional, default: "SkyUp CRM")
 *
 * SCHEDULE SUMMARY:
 *   0 9 * * *    — 9 AM: mark overdue + send daily briefings + alert admins
 *   0 0 * * *    — midnight: re-check overdue
 *   0 *\/6 * * *  — every 6 hours: global workload rebalance
 */

const cron         = require('node-cron');
const Brevo        = require('@getbrevo/brevo');
const Task         = require('../models/tasks');
const User         = require('../models/users');
const Notification = require('../models/notification');
const DailyReport  = require('../models/Dailyreport');
const { rebalanceTasks } = require('./autoAssignService');
const { annotateLockState, stampUnlocks, durationDays } = require('./phaseGate');
const { notifyAdmins } = require('./notify');
const { sendDailyAttendanceDigest } = require('./attendanceAlerts');
const log = require('./assignmentLogger');

// ─── Brevo client factory (mirrors emailController.js pattern) ────────────────

function createBrevoClient() {
  if (!process.env.BREVO_API_KEY) {
    console.warn('[CRON] BREVO_API_KEY not set — emails disabled');
    return null;
  }
  const apiInstance = new Brevo.TransactionalEmailsApi();
  apiInstance.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
  return apiInstance;
}

function senderAddress() {
  return {
    name:  process.env.BREVO_FROM_NAME  || 'SkyUp CRM',
    email: process.env.BREVO_FROM_EMAIL || '',
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayStart() { const d = new Date(); d.setHours(0,0,0,0);     return d; }
function todayEnd()   { const d = new Date(); d.setHours(23,59,59,999); return d; }

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── JOB 1: Mark overdue ─────────────────────────────────────────────────────

async function markOverdueTasks() {
  const now = new Date();

  // 1) Non-phased tasks keep the classic static due_date behaviour.
  const legacy = await Task.updateMany(
    {
      phase:      null,
      due_date:   { $lt: now },
      status:     { $in: ['todo', 'in-progress', 'on-hold'] },
      is_delayed: { $ne: true },
    },
    { $set: { is_delayed: true, delay_reason: 'Auto-marked: past due date' } }
  );

  // 2) Phased tasks: the delay clock starts at unlock. Locked tasks are never
  //    delayed; an unlocked task is delayed once (unlocked_at + duration) passes.
  const projectIds = await Task.find({ phase: { $ne: null } }).distinct('project_id');
  let phasedDelayed = 0;

  for (const pid of projectIds) {
    await stampUnlocks(pid).catch(() => {});

    const candidates = await Task.find({
      project_id: pid,
      phase:      { $ne: null },
      status:     { $in: ['todo', 'in-progress', 'on-hold'] },
      is_delayed: { $ne: true },
    });

    const annotated = await annotateLockState(candidates);
    for (const t of annotated) {
      if (t.is_locked) continue;                        // locked → not counted
      const due = t.effective_due_date;                 // unlocked_at + duration
      if (!due || now <= new Date(due)) continue;       // still within duration

      await Task.updateOne(
        { _id: t._id },
        { $set: { is_delayed: true, delay_reason: 'Not completed within allotted duration after unlock' } }
      );
      await notifyAdmins({
        message:  `⏰ Task "${t.title}" is delayed — not completed within its ${durationDays(t)} day(s) after unlocking.`,
        type:     'task_delayed',
        ref_id:   t._id,
        ref_type: 'Task',
      });
      phasedDelayed += 1;
    }
  }

  const total = (legacy.modifiedCount || 0) + phasedDelayed;
  console.log(`[CRON] Marked ${total} task(s) delayed (${phasedDelayed} phased, ${legacy.modifiedCount || 0} legacy)`);
  return total;
}

// ─── JOB 2: Daily task notifications ─────────────────────────────────────────

async function sendDailyTaskNotifications() {
  const start = todayStart();
  const end   = todayEnd();

  const todaysTasks = await Task.find({
    $or: [
      { start_date: { $gte: start, $lte: end } },
      { status: 'in-progress', is_delayed: false },
    ],
    status: { $in: ['todo', 'in-progress'] },
  })
    .populate('assigned_to',   'name email dailyWorkingHours')
    .populate('project_id',    'title')
    .populate('assignment_id', 'title');

  if (!todaysTasks.length) {
    console.log('[CRON] No tasks scheduled for today');
    return;
  }

  // Group by employee
  const byEmployee = {};
  for (const task of todaysTasks) {
    if (!task.assigned_to) continue;
    const uid = task.assigned_to._id.toString();
    if (!byEmployee[uid]) byEmployee[uid] = { user: task.assigned_to, tasks: [], totalHours: 0 };
    byEmployee[uid].tasks.push(task);
    byEmployee[uid].totalHours += task.estimated_hours || 0;
  }

  const brevo      = createBrevoClient();
  const sender     = senderAddress();
  let   emailsSent = 0;

  for (const uid of Object.keys(byEmployee)) {
    const { user, tasks, totalHours } = byEmployee[uid];
    const dailyCap       = user.dailyWorkingHours || 8;
    const remainingHours = Math.max(0, dailyCap - totalHours);
    const taskTitles     = tasks.map((t) => `• ${t.title}`).join('\n');

    // ── In-app notification (unchanged) ──────────────────────────────────
    await Notification.create({
      user_id:   user._id,
      sender_id: null,
      message:   `📋 Today's work (${new Date().toDateString()}): ${tasks.length} task(s) | ${totalHours}h scheduled | ${remainingHours}h remaining capacity.\n${taskTitles}`,
      type:      'task_reminder',
      ref_id:    null,
      ref_type:  null,
    }).catch(console.error);

    // ── Email via Brevo SDK ───────────────────────────────────────────────
    if (brevo && user.email && sender.email) {
      const taskRows = tasks.map((t) => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:8px 12px">${t.title}</td>
          <td style="padding:8px 12px;color:#6366f1;font-weight:600">${(t.priority || '').toUpperCase()}</td>
          <td style="padding:8px 12px">${t.project_id?.title || '—'}</td>
          <td style="padding:8px 12px">${t.estimated_hours || '—'} hrs</td>
          <td style="padding:8px 12px">${formatDate(t.due_date)}</td>
        </tr>`).join('');

      const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f8f9fa;padding:20px">
        <div style="max-width:700px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
          <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:28px 32px;color:#fff">
            <h2 style="margin:0">📋 Daily Task Briefing</h2>
            <p style="margin:6px 0 0;opacity:.9">${new Date().toLocaleDateString('en-IN',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
          </div>
          <div style="padding:24px 32px">
            <p>Hello <strong>${user.name}</strong>,</p>
            <p>${tasks.length} task(s) scheduled today · ${totalHours}h / ${dailyCap}h capacity</p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <thead><tr style="background:#f8f9fa">
                <th style="padding:10px 12px;text-align:left">Task</th>
                <th style="padding:10px 12px;text-align:left">Priority</th>
                <th style="padding:10px 12px;text-align:left">Project</th>
                <th style="padding:10px 12px;text-align:left">Hrs</th>
                <th style="padding:10px 12px;text-align:left">Due</th>
              </tr></thead>
              <tbody>${taskRows}</tbody>
            </table>
          </div>
        </div>
      </body></html>`;

      try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.sender      = sender;
        sendSmtpEmail.to          = [{ email: user.email, name: user.name }];
        sendSmtpEmail.subject     = `📋 Daily Tasks – ${new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'short'})} | ${tasks.length} task(s)`;
        sendSmtpEmail.htmlContent = html;

        await brevo.sendTransacEmail(sendSmtpEmail);
        emailsSent++;
      } catch (err) {
        console.error(`[CRON] Brevo email failed for ${user.email}:`, err.message);
      }
    }
  }

  console.log(`[CRON] Notifications: ${Object.keys(byEmployee).length} in-app, ${emailsSent} emails via Brevo`);
}

// ─── JOB 2b: Morning "your plan for today" reminder ──────────────────────────

/**
 * Surfaces the `plan_for_tomorrow` an employee wrote in a PREVIOUS day's daily
 * report as an in-app notification the next morning:
 *   "Good morning — here's what you planned for today: …"
 *
 * Idempotent: each report is reminded at most once (plan_reminder_sent flag), so
 * re-runs (or a missed day the job later catches up on) never double-notify.
 * Only reports dated strictly before today are considered, so a report the
 * employee submits *today* (whose plan is for tomorrow) isn't surfaced today.
 * If an employee has several un-reminded reports (e.g. the job missed a day),
 * only their most recent plan is shown as "today's plan"; the older ones are
 * still flagged so they don't resurface later.
 */
async function sendPlanForTodayReminders() {
  const start = todayStart(); // today 00:00

  const reports = await DailyReport.find({
    date:               { $lt: start },
    plan_reminder_sent: { $ne: true },
    plan_for_tomorrow:  { $exists: true, $nin: [null, ''] },
  })
    .sort({ date: -1 })
    .populate('user_id', 'name status');

  if (!reports.length) {
    console.log('[CRON] No pending plan-for-today reminders');
    return;
  }

  const notifiedUsers = new Set();
  const processedIds  = [];
  let   created       = 0;

  for (const r of reports) {
    processedIds.push(r._id); // every processed report gets flagged, notified or not

    const user = r.user_id;
    const uid  = user && user._id ? user._id.toString() : null;
    if (!uid) continue;
    if (notifiedUsers.has(uid)) continue;            // keep only the latest plan per user
    notifiedUsers.add(uid);

    if (user.status && user.status !== 'active') continue; // skip inactive, still flag

    const plan = (r.plan_for_tomorrow || '').trim();
    if (!plan) continue;

    await Notification.create({
      user_id:   user._id,
      sender_id: null,
      message:   `🗓️ Good morning${user.name ? ', ' + user.name : ''}! Here's what you planned for today:\n${plan}`,
      type:      'daily_plan_reminder',
      ref_id:    r._id,
      ref_type:  null,
    }).catch(console.error);
    created += 1;
  }

  if (processedIds.length) {
    await DailyReport.updateMany(
      { _id: { $in: processedIds } },
      { $set: { plan_reminder_sent: true } }
    ).catch(console.error);
  }

  console.log(`[CRON] Plan-for-today reminders: ${created} sent to ${notifiedUsers.size} employee(s)`);
}

// ─── JOB 3: Alert admins about overdue ───────────────────────────────────────

async function alertAdminsAboutOverdue() {
  const overdueCount = await Task.countDocuments({
    is_delayed: true,
    status:     { $in: ['todo', 'in-progress'] },
  });

  if (!overdueCount) return;

  const admins = await User.find({ role: 'admin', status: 'active' }).select('_id');
  for (const admin of admins) {
    await Notification.create({
      user_id:   admin._id,
      sender_id: null,
      message:   `🚨 Daily Report: ${overdueCount} task(s) are overdue and need attention.`,
      type:      'system_alert',
      ref_id:    null,
      ref_type:  null,
    }).catch(console.error);
  }

  console.log(`[CRON] Alerted ${admins.length} admin(s) about ${overdueCount} overdue tasks`);
}

// ─── JOB 4: Periodic workload rebalance ──────────────────────────────────────

/**
 * Runs every 6 hours.
 * Calls rebalanceTasks(null) — null means across ALL projects globally.
 * Only redistributes 'todo' low/medium tasks away from overloaded users.
 * Safe to run frequently — exits immediately if no user exceeds threshold.
 */
async function runRebalanceJob() {
  log.info('[CRON] Periodic rebalance starting');
  try {
    const reassigned = await rebalanceTasks(null, 300, null);
    log.info('[CRON] Periodic rebalance complete', { reassigned: reassigned.length });
  } catch (err) {
    console.error('[CRON] Periodic rebalance failed:', err.message);
  }
}

// ─── JOB 5: Daily attendance digest to Telegram ──────────────────────────────

/**
 * Posts one consolidated Telegram message with every employee's login timing
 * for today — marking who was late and who did overtime. Runs end-of-day so
 * clock-outs (and therefore overtime) are already recorded.
 */
async function runAttendanceDigestJob() {
  try {
    const result = await sendDailyAttendanceDigest(new Date());
    if (result.skipped) {
      console.log('[CRON] Attendance digest skipped (Telegram not configured)');
    } else if (result.ok) {
      console.log('[CRON] Attendance digest sent', result.counts || {});
    } else {
      console.warn('[CRON] Attendance digest failed:', result.error);
    }
  } catch (err) {
    console.error('[CRON] Attendance digest job failed:', err.message);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initCronJobs() {
  // 9 AM daily
  cron.schedule('0 9 * * *', async () => {
    console.log('[CRON] Daily job starting at', new Date().toISOString());
    try {
      await markOverdueTasks();
      await sendDailyTaskNotifications();
      await sendPlanForTodayReminders();
      await alertAdminsAboutOverdue();
    } catch (err) {
      console.error('[CRON] Daily job failed:', err.message);
    }
  });

  // Midnight overdue re-check
  cron.schedule('0 0 * * *', async () => {
    try { await markOverdueTasks(); }
    catch (err) { console.error('[CRON] Midnight overdue check failed:', err.message); }
  });

  // Every 6 hours: workload rebalance
  cron.schedule('0 */6 * * *', runRebalanceJob);

  // Daily attendance digest to Telegram.
  // Default: 14:00 UTC = 19:30 IST (end of day). Override with ATTENDANCE_DIGEST_CRON.
  const digestCron = process.env.ATTENDANCE_DIGEST_CRON || '0 14 * * *';
  cron.schedule(digestCron, () => {
    console.log('[CRON] Attendance digest job starting at', new Date().toISOString());
    runAttendanceDigestJob();
  });

  console.log(`[CRON] Jobs initialized: 9AM daily | midnight overdue | every-6h rebalance | attendance digest (${digestCron})`);
}

module.exports = {
  initCronJobs,
  markOverdueTasks,
  sendDailyTaskNotifications,
  sendPlanForTodayReminders,
  alertAdminsAboutOverdue,
  runRebalanceJob,
  runAttendanceDigestJob,
};