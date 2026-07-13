/**
 * services/trackerDigest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds a detailed per-employee summary of desktop-tracker activity for a given
 * day and broadcasts it to ONE OR MORE Telegram chats.
 *
 * Each employee block shows:
 *   - tracked time, idle time, and the active window (first → last activity)
 *   - productive / neutral / unproductive breakdown (with a productive %)
 *   - the top apps they spent time in
 *   - the projects they logged time against
 *
 * Multiple destinations
 *   Set TELEGRAM_TRACKER_CHAT_IDS to a comma-separated list of chat ids, e.g.
 *       TELEGRAM_TRACKER_CHAT_IDS=-1004364279119,222222222
 *   Each id can be a group/supergroup (negative) or a personal DM chat id. If it
 *   isn't set, the digest falls back to TELEGRAM_CHAT_ID. TELEGRAM_BOT_TOKEN is
 *   always required.
 *
 * Never throws — a Telegram/DB failure here must not crash a cron run.
 */

const ActivityLog = require('../models/ActivityLog');
const User = require('../models/users');
const { classifyBatch } = require('./classificationService');
const { sendTelegramMessage, escapeHtml } = require('./telegram');

const TELEGRAM_MAX = 4096;   // hard Telegram limit
const CHUNK_TARGET = 3500;   // split well below the limit to be safe
const TOP_APPS = 4;          // how many apps to list per employee
const TOP_PROJECTS = 3;      // how many projects to list per employee

// ─── Destinations ───────────────────────────────────────────────────────────
function getChatIds() {
  const raw = process.env.TELEGRAM_TRACKER_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Formatting ─────────────────────────────────────────────────────────────
function fmtDateIST(date = new Date()) {
  return new Date(date).toLocaleDateString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}
function fmtTimeIST(date) {
  if (!date) return '—';
  return new Date(date).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
}
function fmtDuration(totalSeconds) {
  const m = Math.max(0, Math.round(totalSeconds / 60));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h && mm) return `${h}h ${mm}m`;
  if (h) return `${h}h`;
  return `${mm}m`;
}

// ─── Aggregation ────────────────────────────────────────────────────────────
// Builds a rich per-employee record for the day. Uses the shared classifier so
// productive/neutral/unproductive numbers match the dashboard.
async function computePerEmployee(dateObj = new Date()) {
  const dayStart = new Date(dateObj); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const match = { start: { $gte: dayStart, $lt: dayEnd } };

  // 1) Time per user × app × title × idle  (drives totals + top apps).
  // 2) First/last activity per user.
  // 3) Time per user × project (task → project title).
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

  // Classify the non-idle app/title pairs once.
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

  const userIds = Object.keys(perUser);
  if (!userIds.length) return { rows: [], totals: { tracked: 0, idle: 0, productive: 0 } };

  // Names, first/last, and projects lookups.
  const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
  const nameMap = Object.fromEntries(users.map((u) => [String(u._id), u.name || 'Unknown']));

  const spanMap = Object.fromEntries(spanRows.map((s) => [String(s._id), { first: s.first, last: s.last }]));

  const projMap = {}; // uid -> [{title, seconds}]
  for (const p of projRows) {
    const uid = String(p._id.user);
    if (!projMap[uid]) projMap[uid] = [];
    projMap[uid].push({ title: p.project_title || 'Untagged', seconds: p.seconds });
  }

  const list = Object.values(perUser).map((u) => {
    const uid = u.user_id;
    const topApps = Object.entries(appTotals[uid] || {})
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, TOP_APPS);
    return {
      ...u,
      name: nameMap[uid] || 'Unknown',
      first: spanMap[uid]?.first || null,
      last: spanMap[uid]?.last || null,
      topApps,
      projects: (projMap[uid] || []).slice(0, TOP_PROJECTS),
    };
  }).sort((a, b) => b.tracked - a.tracked);

  const totals = list.reduce(
    (a, u) => ({ tracked: a.tracked + u.tracked, idle: a.idle + u.idle, productive: a.productive + u.productive }),
    { tracked: 0, idle: 0, productive: 0 }
  );

  return { rows: list, totals };
}

// ─── Message building ───────────────────────────────────────────────────────
function buildText(dateObj, data) {
  const header = `📊 <b>Tracker Summary</b> — ${escapeHtml(fmtDateIST(dateObj))}`;
  if (!data.rows.length) {
    return { text: `${header}\n\nNo tracked activity recorded.`, counts: { employees: 0 } };
  }

  const teamPct = data.totals.tracked
    ? Math.round((data.totals.productive / data.totals.tracked) * 100)
    : 0;

  const lines = [header, ''];
  lines.push(`👥 ${data.rows.length} employees · ${fmtDuration(data.totals.tracked)} tracked · ${teamPct}% productive`);

  data.rows.forEach((u, i) => {
    const pct = u.tracked ? Math.round((u.productive / u.tracked) * 100) : 0;
    lines.push('');
    lines.push(`${i + 1}. <b>${escapeHtml(u.name)}</b>`);
    lines.push(`   ⏱ ${fmtDuration(u.tracked)} tracked · 💤 ${fmtDuration(u.idle)} idle · 🕘 ${fmtTimeIST(u.first)}–${fmtTimeIST(u.last)}`);
    lines.push(`   ✅ ${fmtDuration(u.productive)} (${pct}%) · ➖ ${fmtDuration(u.neutral)} · ⛔ ${fmtDuration(u.unproductive)}`);
    if (u.topApps.length) {
      const apps = u.topApps.map((a) => `${escapeHtml(a.name)} ${fmtDuration(a.seconds)}`).join(', ');
      lines.push(`   🔝 ${apps}`);
    }
    if (u.projects.length) {
      const projs = u.projects.map((p) => `${escapeHtml(p.title)} ${fmtDuration(p.seconds)}`).join(', ');
      lines.push(`   📁 ${projs}`);
    }
  });

  return { text: lines.join('\n'), counts: { employees: data.rows.length } };
}

// Split a long message on line boundaries so no chunk exceeds Telegram's limit.
function chunk(text) {
  if (text.length <= TELEGRAM_MAX) return [text];
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > CHUNK_TARGET && buf) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────
async function buildTrackerDigest(dateObj = new Date()) {
  const data = await computePerEmployee(dateObj);
  return buildText(dateObj, data);
}

async function sendTrackerDigest(dateObj = new Date()) {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN not set' };
    }
    const chatIds = getChatIds();
    if (!chatIds.length) {
      return { ok: false, skipped: true, error: 'No chat ids configured (TELEGRAM_TRACKER_CHAT_IDS / TELEGRAM_CHAT_ID)' };
    }

    const { text, counts } = await buildTrackerDigest(dateObj);
    const parts = chunk(text);

    let sent = 0;
    let failed = 0;
    for (const chatId of chatIds) {
      for (const part of parts) {
        const r = await sendTelegramMessage(part, { chatId });
        if (r.ok) sent += 1; else failed += 1;
      }
    }

    return { ok: sent > 0, chats: chatIds.length, sent, failed, counts };
  } catch (err) {
    console.error('[trackerDigest] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { buildTrackerDigest, sendTrackerDigest, computePerEmployee, getChatIds };