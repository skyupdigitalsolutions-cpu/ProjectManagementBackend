/**
 * services/productivityAnalyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The orchestrator. For a given day it:
 *
 *   1. Builds the TITLE breakdown from ActivityLog (time-weighted productive/
 *      neutral/unproductive) using the shared classificationService — the exact
 *      same numbers the dashboard shows.
 *   2. Builds the SCREENSHOT breakdown from screenshotVision (vision verdict per
 *      non-idle screenshot).
 *   3. BLENDS the two into a single productive % / score.
 *   4. PERSISTS one DailyProductivity row per employee (idempotent upsert on
 *      user_id + day_key), so the summary lives in the database.
 *
 * trackerDigest.js consumes the rows this returns to build the Telegram message.
 * This module never sends Telegram itself — separation of concerns.
 *
 * Blend weights (env, both default 0.5):
 *   PRODUCTIVITY_TITLE_WEIGHT   weight of the tab-title signal
 *   PRODUCTIVITY_SHOT_WEIGHT    weight of the screenshot signal
 * If only one signal is available for an employee, that signal is used at 100%.
 */

const ActivityLog = require('../models/ActivityLog');
const IdleReason = require('../models/IdleReason');
const User = require('../models/users');
const DailyProductivity = require('../models/DailyProductivity');
const { classifyBatch } = require('./classificationService');
const { analyzeRange } = require('./screenshotVision');

const TOP_APPS = 6;
const TOP_PROJECTS = 4;

const W_TITLE = clamp01(Number(process.env.PRODUCTIVITY_TITLE_WEIGHT ?? 0.5));
const W_SHOT = clamp01(Number(process.env.PRODUCTIVITY_SHOT_WEIGHT ?? 0.5));

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// IST calendar day string, e.g. "2026-08-22" (used as the upsert key).
function dayKeyIST(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Compute + persist the day's per-employee productivity.
 * @param {Date} dateObj  any instant within the target day
 * @param {Object} [opts]
 * @param {boolean} [opts.persist=true]  write DailyProductivity rows
 * @returns {Promise<{ rows: Array, totals: Object, day_key: string }>}
 */
async function computeDailyProductivity(dateObj = new Date(), opts = {}) {
  const persist = opts.persist !== false;

  const dayStart = new Date(dateObj); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const day_key = dayKeyIST(dayStart);
  const match = { start: { $gte: dayStart, $lt: dayEnd } };

  // ── 1) Title signal: time per user × app × title × idle, spans, projects ────
  const [rows, spanRows, projRows] = await Promise.all([
    ActivityLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { user_id: '$user_id', app_name: '$app_name', window_title: '$window_title', is_idle: '$is_idle' },
          seconds: { $sum: '$duration_sec' },
        },
      },
    ]),
    ActivityLog.aggregate([
      { $match: match },
      { $group: { _id: '$user_id', first: { $min: '$start' }, last: { $max: '$end' } } },
    ]),
    ActivityLog.aggregate([
      { $match: { ...match, is_idle: false, task_id: { $ne: null } } },
      { $group: { _id: { user: '$user_id', task: '$task_id' }, seconds: { $sum: '$duration_sec' } } },
      { $lookup: { from: 'tasks', localField: '_id.task', foreignField: '_id', as: 'task' } },
      { $unwind: { path: '$task', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: 'projects', localField: 'task.project_id', foreignField: '_id', as: 'project' } },
      { $unwind: { path: '$project', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { user: '$_id.user', project: '$project._id' },
          project_title: { $first: '$project.title' },
          seconds: { $sum: '$seconds' },
        },
      },
      { $sort: { seconds: -1 } },
    ]),
  ]);

  // Classify the non-idle app/title pairs once (manual rules + AI cache).
  const pairs = rows
    .filter((r) => !r._id.is_idle)
    .map((r) => ({ app_name: r._id.app_name, window_title: r._id.window_title }));
  const { result: catMap, makeSignature } = await classifyBatch(pairs);
  const classify = (app, title) => catMap.get(makeSignature(app, title)) || 'neutral';

  const perUser = {};
  const appTotals = {}; // uid -> { appName -> seconds }
  for (const r of rows) {
    const uid = String(r._id.user_id);
    if (!perUser[uid]) {
      perUser[uid] = { user_id: uid, tracked: 0, idle: 0, productive: 0, neutral: 0, unproductive: 0 };
      appTotals[uid] = {};
    }
    if (r._id.is_idle) {
      perUser[uid].idle += r.seconds;
    } else {
      perUser[uid].tracked += r.seconds;
      perUser[uid][classify(r._id.app_name, r._id.window_title)] += r.seconds;
      const app = r._id.app_name || 'Unknown';
      appTotals[uid][app] = (appTotals[uid][app] || 0) + r.seconds;
    }
  }

  // Users who have activity logs. We also merge in users who only have
  // screenshots (rare, but keeps the two signals independent).
  const shotStats = await analyzeRange(dayStart, dayEnd, null);
  for (const uid of shotStats.keys()) {
    if (!perUser[uid]) {
      perUser[uid] = { user_id: uid, tracked: 0, idle: 0, productive: 0, neutral: 0, unproductive: 0 };
      appTotals[uid] = {};
    }
  }

  const userIds = Object.keys(perUser);
  if (!userIds.length) {
    return { rows: [], totals: { tracked: 0, idle: 0, productive: 0 }, day_key };
  }

  // Names, spans, projects, idle reasons.
  const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
  const nameMap = Object.fromEntries(users.map((u) => [String(u._id), u.name || 'Unknown']));
  const spanMap = Object.fromEntries(spanRows.map((s) => [String(s._id), { first: s.first, last: s.last }]));

  const projMap = {};
  for (const p of projRows) {
    const uid = String(p._id.user);
    if (!projMap[uid]) projMap[uid] = [];
    projMap[uid].push({ title: p.project_title || 'Untagged', seconds: p.seconds });
  }

  const reasonRows = await IdleReason.find({ idle_start: { $gte: dayStart, $lt: dayEnd } })
    .sort({ idle_start: 1 })
    .select('user_id idle_start idle_end duration_sec reason')
    .lean();
  const reasonMap = {};
  for (const r of reasonRows) {
    const uid = String(r.user_id);
    if (!reasonMap[uid]) reasonMap[uid] = [];
    reasonMap[uid].push(r);
  }

  // ── 3) Blend per user and shape the row ─────────────────────────────────────
  const list = userIds.map((uid) => {
    const u = perUser[uid];
    const topApps = Object.entries(appTotals[uid] || {})
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, TOP_APPS);

    // Title productive % (of tracked time).
    const titlePct = u.tracked ? (u.productive / u.tracked) * 100 : null;

    // Screenshot productive % (of analyzed, non-idle shots).
    const shot = shotStats.get(uid) || { total: 0, idle_skipped: 0, analyzed: 0, productive: 0, neutral: 0, unproductive: 0 };
    const shotPct = shot.analyzed ? (shot.productive / shot.analyzed) * 100 : null;

    // Weighted blend — fall back to whichever signal exists.
    let blended;
    let basis;
    if (titlePct != null && shotPct != null) {
      const wSum = W_TITLE + W_SHOT || 1;
      blended = (titlePct * W_TITLE + shotPct * W_SHOT) / wSum;
      basis = 'both';
    } else if (titlePct != null) {
      blended = titlePct; basis = 'title';
    } else if (shotPct != null) {
      blended = shotPct; basis = 'screenshot';
    } else {
      blended = 0; basis = 'none';
    }

    return {
      user_id: uid,
      name: nameMap[uid] || 'Unknown',
      tracked: u.tracked,
      idle: u.idle,
      // title signal (seconds)
      productive: u.productive,
      neutral: u.neutral,
      unproductive: u.unproductive,
      title_pct: titlePct == null ? 0 : Math.round(titlePct),
      // screenshot signal (counts)
      shots: shot,
      shot_pct: shotPct == null ? 0 : Math.round(shotPct),
      // blend
      productive_pct: Math.round(blended),
      blend_basis: basis,
      first: spanMap[uid]?.first || null,
      last: spanMap[uid]?.last || null,
      topApps,
      projects: (projMap[uid] || []).slice(0, TOP_PROJECTS),
      idleReasons: reasonMap[uid] || [],
    };
  }).sort((a, b) => b.tracked - a.tracked);

  const totals = list.reduce(
    (a, u) => ({
      tracked: a.tracked + u.tracked,
      idle: a.idle + u.idle,
      productive: a.productive + u.productive,
    }),
    { tracked: 0, idle: 0, productive: 0 }
  );

  // ── 4) Persist (idempotent upsert per employee) ─────────────────────────────
  if (persist) {
    const ops = list.map((u) => ({
      updateOne: {
        filter: { user_id: u.user_id, day_key },
        update: {
          $set: {
            user_id: u.user_id,
            user_name: u.name,
            day_key,
            date: dayStart,
            tracked_sec: u.tracked,
            idle_sec: u.idle,
            first_activity: u.first,
            last_activity: u.last,
            title: {
              productive_sec: u.productive,
              neutral_sec: u.neutral,
              unproductive_sec: u.unproductive,
              productive_pct: u.title_pct,
            },
            screenshots: {
              total: u.shots.total,
              idle_skipped: u.shots.idle_skipped,
              analyzed: u.shots.analyzed,
              productive: u.shots.productive,
              neutral: u.shots.neutral,
              unproductive: u.shots.unproductive,
              productive_pct: u.shot_pct,
            },
            productive_pct: u.productive_pct,
            productivity_score: u.productive_pct,
            blend_basis: u.blend_basis,
            top_apps: u.topApps,
            projects: u.projects,
            idle_reasons_count: u.idleReasons.length,
            computed_at: new Date(),
            method_version: 1,
          },
        },
        upsert: true,
      },
    }));
    if (ops.length) {
      try {
        await DailyProductivity.bulkWrite(ops, { ordered: false });
      } catch (err) {
        console.error('[productivityAnalyzer] persist failed:', err.message);
      }
    }
  }

  return { rows: list, totals, day_key };
}

module.exports = { computeDailyProductivity, dayKeyIST };