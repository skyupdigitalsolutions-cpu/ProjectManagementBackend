/**
 * services/telegram.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tiny wrapper around the Telegram Bot API used for attendance alerts
 * (overtime + daily login-timing digest).
 *
 * SETUP (one-time):
 *   1. Open Telegram, talk to @BotFather → /newbot → copy the bot token.
 *   2. Add the bot to the group/channel you want alerts in (or DM the bot).
 *   3. Get the chat id:
 *        - For a group: add @RawDataBot to the group, it prints the chat id
 *          (group ids are negative, e.g. -1001234567890).
 *        - For a DM: message the bot, then open
 *          https://api.telegram.org/bot<TOKEN>/getUpdates and read chat.id.
 *
 * ENV VARS:
 *   TELEGRAM_BOT_TOKEN   — bot token from @BotFather      (required)
 *   TELEGRAM_CHAT_ID     — default destination chat id     (required)
 *
 * Never throws — a Telegram failure must never break attendance saving.
 */

const axios = require("axios");

const TELEGRAM_API = "https://api.telegram.org";

/** True only when both the bot token and a default chat id are configured. */
function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Escape the characters Telegram's HTML parse-mode treats as markup.
 * Use this on any dynamic value (employee names, etc.) before embedding it
 * inside an HTML-formatted message.
 */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send a message to Telegram.
 *
 * @param {string} text                      Message text (HTML by default).
 * @param {Object} [opts]
 * @param {string} [opts.chatId]             Override the default chat id.
 * @param {string} [opts.parseMode='HTML']   'HTML' | 'MarkdownV2' | '' (plain).
 * @param {boolean}[opts.disablePreview=true]
 * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, data?:object}>}
 */
async function sendTelegramMessage(text, opts = {}) {
  const {
    chatId,
    parseMode = "HTML",
    disablePreview = true,
  } = opts;

  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — message skipped");
      return { ok: false, skipped: true };
    }

    const target = chatId || process.env.TELEGRAM_CHAT_ID;
    if (!target) {
      console.warn("[telegram] TELEGRAM_CHAT_ID not set — message skipped");
      return { ok: false, skipped: true };
    }

    const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
    const payload = {
      chat_id: target,
      text,
      disable_web_page_preview: disablePreview,
    };
    if (parseMode) payload.parse_mode = parseMode;

    const { data } = await axios.post(url, payload, { timeout: 10000 });
    return { ok: true, data };
  } catch (err) {
    const reason = err.response?.data?.description || err.message;
    console.error("[telegram] send failed:", reason);
    return { ok: false, error: reason };
  }
}

module.exports = { sendTelegramMessage, isConfigured, escapeHtml };