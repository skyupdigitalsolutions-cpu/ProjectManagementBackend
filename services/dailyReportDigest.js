/**
 * services/dailyReportDigest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Collects the employees' Daily Reports for a given day and broadcasts a digest
 * to ONE OR MORE Telegram chats — a SEPARATE destination from the tracker
 * summary, so it can go to its own group.
 *
 * Each report block shows: mood, summary, tasks completed, blockers, and the
 * plan for tomorrow. A footer lists who hasn't submitted yet.
 *
 * Destinations
 *   Set TELEGRAM_DAILY_REPORT_CHAT_IDS to a comma-separated list of chat ids
 *   (group/supergroup ids are negative, e.g. -1004364279119). There is NO
 *   fallback to TELEGRAM_CHAT_ID here — that keeps daily reports from ever
 *   leaking into the attendance/tracker group by accident. TELEGRAM_BOT_TOKEN
 *   is still required.
 *
 * Never throws — a Telegram/DB failure here must not crash a cron run.
 */

const DailyReport = require('../models/Dailyreport');
const User = require('../models/users');
const { sendTelegramMessage, escapeHtml } = require('./telegram');

const TELEGRAM_MAX = 4096;
const CHUNK_TARGET = 3500;

const MOOD_EMOJI = { great: '😄', good: '🙂', okay: '😐', struggling: '😟' };

// ─── Destinations ───────────────────────────────────────────────────────────
// NOTE: deliberately no TELEGRAM_CHAT_ID fallback (separate group by design).
function getChatIds() {
  const raw = process.env.TELEGRAM_DAILY_REPORT_CHAT_IDS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Formatting ─────────────────────────────────────────────────────────────
function fmtDateIST(date = new Date()) {
  return new Date(date).toLocaleDateString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

// ─── Data ─────────────────────────────────────────────────────────────────────
async function computeDailyReports(dateObj = new Date()) {
  const dayStart = new Date(dateObj); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

  const [reports, employees] = await Promise.all([
    DailyReport.find({ date: { $gte: dayStart, $lt: dayEnd } })
      .populate('user_id', 'name')
      .sort({ createdAt: 1 })
      .lean(),
    User.find({ role: 'employee', status: { $ne: 'inactive' } }).select('name').lean(),
  ]);

  const submittedIds = new Set(reports.map((r) => String(r.user_id?._id || r.user_id)));
  const missing = employees
    .filter((e) => !submittedIds.has(String(e._id)))
    .map((e) => e.name || 'Unknown');

  return { reports, totalEmployees: employees.length, submitted: reports.length, missing };
}

// ─── Message building ───────────────────────────────────────────────────────
function buildText(dateObj, data) {
  const header = `📝 <b>Daily Reports</b> — ${escapeHtml(fmtDateIST(dateObj))}`;

  if (!data.reports.length) {
    const none = `${header}\n\nNo reports submitted yet (0 of ${data.totalEmployees}).`;
    return { text: none, counts: { submitted: 0, total: data.totalEmployees } };
  }

  const lines = [header, ''];
  lines.push(`✅ ${data.submitted} of ${data.totalEmployees} submitted`);

  data.reports.forEach((r, i) => {
    const name = r.user_id?.name || 'Unknown';
    const mood = r.mood || 'good';
    const moodEmoji = MOOD_EMOJI[mood] || '🙂';
    lines.push('');
    lines.push(`${i + 1}. <b>${escapeHtml(name)}</b>  ${moodEmoji} ${escapeHtml(mood)}`);
    if (r.summary) lines.push(`   ${escapeHtml(r.summary)}`);
    if (Array.isArray(r.tasks_completed) && r.tasks_completed.length) {
      lines.push(`   ✔ Done: ${escapeHtml(r.tasks_completed.join('; '))}`);
    }
    if (r.blockers) lines.push(`   ⛔ Blockers: ${escapeHtml(r.blockers)}`);
    if (r.plan_for_tomorrow) lines.push(`   ➡ Tomorrow: ${escapeHtml(r.plan_for_tomorrow)}`);
  });

  if (data.missing.length) {
    lines.push('');
    lines.push(`🔴 Not submitted (${data.missing.length}): ${escapeHtml(data.missing.join(', '))}`);
  }

  return { text: lines.join('\n'), counts: { submitted: data.submitted, total: data.totalEmployees, missing: data.missing.length } };
}

// Split long messages on line boundaries so no chunk exceeds Telegram's limit.
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
async function buildDailyReportDigest(dateObj = new Date()) {
  const data = await computeDailyReports(dateObj);
  return buildText(dateObj, data);
}

async function sendDailyReportDigest(dateObj = new Date()) {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN not set' };
    }
    const chatIds = getChatIds();
    if (!chatIds.length) {
      return { ok: false, skipped: true, error: 'No chat ids configured (TELEGRAM_DAILY_REPORT_CHAT_IDS)' };
    }

    const { text, counts } = await buildDailyReportDigest(dateObj);
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
    console.error('[dailyReportDigest] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { buildDailyReportDigest, sendDailyReportDigest, computeDailyReports, getChatIds };