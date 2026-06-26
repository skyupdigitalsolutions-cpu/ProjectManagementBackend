/**
 * jobs/leaveCarryForwardJob.js  — NEW
 *
 * Monthly cron job that:
 *   1. Carries forward unused leave balances to the next month
 *   2. Expires comp-offs past their expiry date
 *
 * Schedule: Runs on the 1st of each month at 00:05 AM (configurable via policy).
 *
 * PLACE AT: Project-Management-Backend/jobs/leaveCarryForwardJob.js
 *
 * SETUP in server.js (add after DB connect):
 *   require('./jobs/leaveCarryForwardJob');
 *
 * REQUIRES: npm install node-cron
 */

const cron             = require('node-cron');
const User             = require('../models/users');
const Leave            = require('../models/leave');
const LeaveBalance     = require('../models/LeaveBalance');
const CompOff          = require('../models/CompOff');
const AttendancePolicy = require('../models/AttendancePolicy');

// ─── Helper: Get or init a user's LeaveBalance for a year ────────────────────

async function getOrCreateBalance(userId, year, leaveTypes) {
  let balance = await LeaveBalance.findOne({ user_id: userId, year });
  if (balance) return balance;

  // Initialise with policy allocations
  const balances = leaveTypes.map(lt => ({
    leave_type:      lt.type,
    allowed:         lt.allowed_per_year ?? 12,
    used:            0,
    remaining:       lt.allowed_per_year ?? 12,
    carried_forward: 0,
  }));

  balance = await LeaveBalance.create({ user_id: userId, year, balances });
  return balance;
}

// ─── Core carry-forward logic ─────────────────────────────────────────────────

async function runCarryForward() {
  console.log('[CarryForward] Starting monthly leave carry-forward job...');

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  // Load active policy
  const policy = await AttendancePolicy.findOne({ is_active: true }).lean();
  const leaveTypes = policy?.leave_types ?? [];

  // Get all active employees + managers
  const users = await User.find({ status: 'active', role: { $in: ['employee', 'manager'] } }).select('_id name');

  console.log(`[CarryForward] Processing ${users.length} users for ${year}-${String(month).padStart(2, '0')}`);

  let carried = 0;
  let skipped = 0;

  for (const user of users) {
    try {
      const balance = await getOrCreateBalance(user._id, year, leaveTypes);

      // Skip if already ran this month
      if (balance.last_carry_forward_at) {
        const lastRun = new Date(balance.last_carry_forward_at);
        if (lastRun.getFullYear() === year && lastRun.getMonth() + 1 === month) {
          skipped++;
          continue;
        }
      }

      // Count approved leaves this month per type
      const monthStart = new Date(year, month - 2, 1);  // previous month start
      const monthEnd   = new Date(year, month - 1, 0);  // previous month end

      const monthLeaves = await Leave.aggregate([
        {
          $match: {
            user_id:   user._id,
            status:    'approved',
            from_date: { $gte: monthStart, $lte: monthEnd },
          },
        },
        { $group: { _id: '$leave_type', totalDays: { $sum: '$days' } } },
      ]);

      const usedByType = Object.fromEntries(monthLeaves.map(l => [l._id, l.totalDays]));

      // Apply carry-forward rules from policy
      for (const lt of leaveTypes) {
        if (!lt.carry_forward) continue;

        const bal  = balance.balances.find(b => b.leave_type === lt.type);
        if (!bal) continue;

        const usedThisMonth = usedByType[lt.type] ?? 0;
        const unused        = Math.max(0, (bal.remaining ?? 0) - usedThisMonth);
        const toCarry       = Math.min(unused, lt.carry_forward_max ?? 0);

        if (toCarry > 0) {
          bal.carried_forward = (bal.carried_forward ?? 0) + toCarry;
          bal.remaining       = Math.min(bal.allowed + bal.carried_forward, (lt.carry_forward_max ?? 0) + bal.allowed);
          console.log(`[CarryForward]   ${user.name}: carried ${toCarry} ${lt.type} days`);
        }

        bal.used = (bal.used ?? 0) + usedThisMonth;
      }

      balance.last_carry_forward_at = now;
      await balance.save();
      carried++;
    } catch (err) {
      console.error(`[CarryForward] Error for user ${user._id}:`, err.message);
    }
  }

  console.log(`[CarryForward] Done — carried: ${carried}, skipped: ${skipped}`);
}

// ─── Expire stale comp-offs ───────────────────────────────────────────────────

async function expireCompOffs() {
  const today  = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await CompOff.updateMany(
    { status: 'active', expires_on: { $lt: today } },
    { $set: { status: 'expired' } }
  );

  console.log(`[CompOff] Expired ${result.modifiedCount} comp-off records`);
}

// ─── Schedule ─────────────────────────────────────────────────────────────────

// Run at 00:05 AM on the 1st of every month
cron.schedule('5 0 1 * *', async () => {
  console.log('[Cron] Monthly carry-forward triggered');
  try {
    await expireCompOffs();
    await runCarryForward();
  } catch (err) {
    console.error('[Cron] Carry-forward job failed:', err.message);
  }
}, {
  scheduled: true,
  timezone:  'Asia/Kolkata',
});

// Also expire comp-offs daily at midnight
cron.schedule('1 0 * * *', async () => {
  try { await expireCompOffs(); } catch (err) { console.error('[Cron] CompOff expiry failed:', err.message); }
}, { scheduled: true, timezone: 'Asia/Kolkata' });

console.log('[Jobs] Leave carry-forward and comp-off expiry jobs scheduled');

// ─── Export for manual trigger from admin ────────────────────────────────────
module.exports = { runCarryForward, expireCompOffs };