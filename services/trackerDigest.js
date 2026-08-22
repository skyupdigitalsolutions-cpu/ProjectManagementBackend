/**
 * services/trackerDigest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds a detailed per-employee productivity summary for a given day and
 * broadcasts it to ONE OR MORE Telegram chats.
 *
 * As of the productivity upgrade this is a THIN layer over
 * services/productivityAnalyzer.js:
 *   - the analyzer computes the title signal (ActivityLog) AND the screenshot
 *     signal (vision), blends them, and PERSISTS one DailyProductivity row per
 *     employee. Simply building/sending the digest also stores the day.
 *   - this file only formats those rows into a Telegram message and sends it.
 *
 * Each employee block now shows:
 *   - a BLENDED productive score (titles + screenshots)
 *   - tracked / idle time and the active window (first → last)
 *   - the title breakdown (productive / neutral / unproductive time)
 *   - the screenshot verdict (how many shots looked productive/neutral/unprod.)
 *   - top apps, projects, and any idle reasons the employee submitted
 *
 * Multiple destinations
 *   Set TELEGRAM_TRACKER_CHAT_IDS to a comma-separated list of chat ids. Each id
 *   can be a group/supergroup (negative) or a personal DM chat id. If it isn't
 *   set, the digest falls back to TELEGRAM_CHAT_ID. TELEGRAM_BOT_TOKEN is always
 *   required.
 *
 * Never throws — a Telegram/DB failure here must not crash a cron run.
 */

const { computeDailyProductivity } = require('./productivityAnalyzer');
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

// ─── Message building ───────────────────────────────────────────────────────
function buildText(dateObj, data) {
  const header = `📊 <b>Productivity Summary</b> — ${escapeHtml(fmtDateIST(dateObj))}`;
  if (!data.rows.length) {
    return { text: `${header}\n\nNo tracked activity recorded.`, counts: { employees: 0 } };
  }

  const teamPct = data.totals.tracked
    ? Math.round((data.totals.productive / data.totals.tracked) * 100)
    : 0;

  const lines = [header, ''];
  lines.push(`👥 ${data.rows.length} employees · ${fmtDuration(data.totals.tracked)} tracked · ${teamPct}% productive (titles)`);

  data.rows.forEach((u, i) => {
    lines.push('');
    lines.push(`${i + 1}. <b>${escapeHtml(u.name)}</b> — 🎯 ${u.productive_pct}% productive`);
    lines.push(`   ⏱ ${fmtDuration(u.tracked)} tracked · 💤 ${fmtDuration(u.idle)} idle · 🕘 ${fmtTimeIST(u.first)}–${fmtTimeIST(u.last)}`);
    // Title (time-weighted) breakdown
    lines.push(`   📝 titles: ✅ ${fmtDuration(u.productive)} (${u.title_pct}%) · ➖ ${fmtDuration(u.neutral)} · ⛔ ${fmtDuration(u.unproductive)}`);
    // Screenshot (vision) breakdown
    if (u.shots && u.shots.analyzed) {
      lines.push(`   📸 shots: ${u.shots.analyzed} scored → ✅ ${u.shots.productive} · ➖ ${u.shots.neutral} · ⛔ ${u.shots.unproductive} (${u.shot_pct}%)`);
    } else if (u.shots && u.shots.total) {
      lines.push(`   📸 shots: ${u.shots.total} captured (not scored)`);
    }
    if (u.topApps.length) {
      const apps = u.topApps.slice(0, TOP_APPS).map((a) => `${escapeHtml(a.name)} ${fmtDuration(a.seconds)}`).join(', ');
      lines.push(`   🔝 ${apps}`);
    }
    if (u.projects.length) {
      const projs = u.projects.slice(0, TOP_PROJECTS).map((p) => `${escapeHtml(p.title)} ${fmtDuration(p.seconds)}`).join(', ');
      lines.push(`   📁 ${projs}`);
    }
    const IDLE_REASON_LINES = 5;
    if (u.idleReasons && u.idleReasons.length) {
      for (const r of u.idleReasons.slice(0, IDLE_REASON_LINES)) {
        lines.push(
          `   🗒 ${fmtTimeIST(r.idle_start)}–${fmtTimeIST(r.idle_end)} (${fmtDuration(r.duration_sec)}) — ${escapeHtml(String(r.reason).slice(0, 80))}`
        );
      }
      if (u.idleReasons.length > IDLE_REASON_LINES) {
        lines.push(`   🗒 +${u.idleReasons.length - IDLE_REASON_LINES} more idle reasons`);
      }
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
// Building the digest ALSO computes + persists the day's DailyProductivity rows
// (persist defaults to true inside the analyzer).
async function buildTrackerDigest(dateObj = new Date()) {
  const data = await computeDailyProductivity(dateObj);
  return buildText(dateObj, data);
}

async function sendTrackerDigest(dateObj = new Date()) {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      // Still compute + persist even if we can't send.
      await computeDailyProductivity(dateObj).catch(() => {});
      return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN not set' };
    }
    const chatIds = getChatIds();
    if (!chatIds.length) {
      await computeDailyProductivity(dateObj).catch(() => {});
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

module.exports = {
  buildTrackerDigest,
  sendTrackerDigest,
  getChatIds,
  // Back-compat: some callers imported computePerEmployee. It now delegates to
  // the analyzer (which also persists). Returns { rows, totals }.
  computePerEmployee: (d) => computeDailyProductivity(d),
};