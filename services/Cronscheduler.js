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
const { rebalanceTasks } = require('./autoAssignService');
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
  const result = await Task.updateMany(
    {
      due_date:   { $lt: new Date() },
      status:     { $in: ['todo', 'in-progress', 'on-hold'] },
      is_delayed: { $ne: true },
    },
    { $set: { is_delayed: true, delay_reason: 'Auto-marked: past due date' } }
  );
  console.log(`[CRON] Marked ${result.modifiedCount} tasks as overdue`);
  return result.modifiedCount;
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

// ─── Init ─────────────────────────────────────────────────────────────────────

function initCronJobs() {
  // 9 AM daily
  cron.schedule('0 9 * * *', async () => {
    console.log('[CRON] Daily job starting at', new Date().toISOString());
    try {
      await markOverdueTasks();
      await sendDailyTaskNotifications();
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

  console.log('[CRON] Jobs initialized: 9AM daily | midnight overdue | every-6h rebalance');
}

module.exports = {
  initCronJobs,
  markOverdueTasks,
  sendDailyTaskNotifications,
  alertAdminsAboutOverdue,
  runRebalanceJob,
};