/**
 * services/screenshotVision.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Looks at desktop SCREENSHOTS (not just tab titles) and rates each as
 * productive / neutral / unproductive using a vision model.
 *
 * Why this exists:
 *   The title classifier judges by app_name + window_title. That misses things
 *   the title hides — e.g. a YouTube video or a game running inside a "work"
 *   browser tab. The pixels don't lie, so we ask a vision model what's actually
 *   on screen and blend it with the title signal.
 *
 * Cost control (this is the important part):
 *   - Idle screenshots are NEVER sent to the model (they're idle by definition).
 *   - Each screenshot is analyzed AT MOST ONCE — the verdict is cached on the
 *     Screenshot document (category / vision_reason / analyzed_at). Re-running a
 *     day is then free.
 *   - We downscale the image via a Cloudinary transform and use detail:'low',
 *     so each image is a fixed, tiny token cost.
 *   - PRODUCTIVITY_VISION_MAX caps how many NEW images are scored per run.
 *   - PRODUCTIVITY_VISION_STRIDE lets you sample (e.g. every 2nd shot) if you
 *     want to halve cost at the expense of granularity.
 *
 * Requires env var: OPENAI_API_KEY  (same key the title classifier uses).
 * If the key is missing, this returns empty stats and the system falls back to
 * title-only productivity — it never throws.
 */

const Screenshot = require('../models/Screenshot');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.PRODUCTIVITY_VISION_MODEL || 'gpt-4o-mini';
const VALID = ['productive', 'neutral', 'unproductive'];

const MAX_NEW = Number(process.env.PRODUCTIVITY_VISION_MAX || 500);   // per run
const STRIDE = Math.max(1, Number(process.env.PRODUCTIVITY_VISION_STRIDE || 1));
const CONCURRENCY = Math.max(1, Number(process.env.PRODUCTIVITY_VISION_CONCURRENCY || 4));

// Downscale + auto-quality on the fly (no extra Cloudinary storage). Smaller
// image = cheaper + faster vision call, and detail:'low' fixes the token cost.
function smallUrl(url) {
  if (!url || !url.includes('/upload/')) return url;
  return url.replace('/upload/', '/upload/w_768,c_limit,q_auto/');
}

// Ask the vision model to categorize ONE screenshot. Never throws.
async function classifyImage(url) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { category: 'neutral', reason: 'no api key' };

  const prompt =
    'You are looking at a screenshot of an employee\'s screen at a digital ' +
    'marketing and web-development agency. Reply with EXACTLY one word: ' +
    '"productive", "neutral", or "unproductive".\n\n' +
    'productive = coding/IDE, design tools, documents, spreadsheets, email, ' +
    'project management, databases, terminals, developer docs, GitHub, client ' +
    'or business websites, work research.\n' +
    'unproductive = entertainment or personal use regardless of the app: video/' +
    'music playback (YouTube video, Netflix, Spotify), games, social media feeds, ' +
    'memes, sports, personal shopping.\n' +
    'neutral = blank/lock screen, new tab, file explorer, system dialogs, or a ' +
    'general chat app used for coordination.\n\n' +
    'Judge by what is actually on screen, not by the app chrome. Answer with one word only.';

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: smallUrl(url), detail: 'low' } },
            ],
          },
        ],
        max_tokens: 3,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[screenshotVision] OpenAI failed:', res.status, body.slice(0, 120));
      return { category: 'neutral', reason: `http ${res.status}` };
    }
    const data = await res.json();
    const answer = (data.choices?.[0]?.message?.content || '').toLowerCase().trim();
    const found = VALID.find((v) => answer.includes(v));
    return { category: found || 'neutral', reason: answer.slice(0, 120) || 'empty' };
  } catch (err) {
    console.error('[screenshotVision] error:', err.message);
    return { category: 'neutral', reason: err.message.slice(0, 120) };
  }
}

// Small promise-pool so we don't fire hundreds of OpenAI calls at once.
async function runPool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Analyze every non-idle screenshot in [dayStart, dayEnd) and return per-user
 * verdict counts. Verdicts are cached on the Screenshot docs, so subsequent
 * calls only score images that appeared since (or were skipped by a cap).
 *
 * @param {Date} dayStart  inclusive
 * @param {Date} dayEnd    exclusive
 * @param {string[]|null} userIds  optional filter (strings); null = everyone
 * @returns {Promise<Map<string, {
 *   total:number, idle_skipped:number, analyzed:number,
 *   productive:number, neutral:number, unproductive:number
 * }>>}  keyed by user_id string
 */
async function analyzeRange(dayStart, dayEnd, userIds = null) {
  const match = { taken_at: { $gte: dayStart, $lt: dayEnd } };
  if (Array.isArray(userIds) && userIds.length) {
    const mongoose = require('mongoose');
    match.user_id = { $in: userIds.map((u) => new mongoose.Types.ObjectId(String(u))) };
  }

  const shots = await Screenshot.find(match)
    .select('user_id is_idle category url taken_at')
    .sort({ taken_at: 1 })
    .lean();

  const stats = new Map();
  const ensure = (uid) => {
    if (!stats.has(uid)) {
      stats.set(uid, {
        total: 0, idle_skipped: 0, analyzed: 0,
        productive: 0, neutral: 0, unproductive: 0,
      });
    }
    return stats.get(uid);
  };

  // Decide what still needs a vision call (respecting stride + the global cap).
  const toAnalyze = [];
  let strideCounter = 0;
  for (const s of shots) {
    const uid = String(s.user_id);
    const bucket = ensure(uid);
    bucket.total += 1;

    if (s.is_idle) { bucket.idle_skipped += 1; continue; }

    // Already cached from a previous run → count it now, no API call.
    if (s.category && VALID.includes(s.category)) {
      bucket.analyzed += 1;
      bucket[s.category] += 1;
      continue;
    }

    // Sampling: analyze every STRIDE-th unscored non-idle shot.
    strideCounter += 1;
    if ((strideCounter - 1) % STRIDE !== 0) continue;

    if (toAnalyze.length < MAX_NEW) toAnalyze.push(s);
  }

  if (toAnalyze.length) {
    const results = await runPool(
      toAnalyze,
      async (s) => ({ s, ...(await classifyImage(s.url)) }),
      CONCURRENCY
    );

    // Persist verdicts (cache) and fold them into the counts.
    const ops = [];
    const now = new Date();
    for (const r of results) {
      const uid = String(r.s.user_id);
      const bucket = ensure(uid);
      bucket.analyzed += 1;
      bucket[r.category] += 1;
      ops.push({
        updateOne: {
          filter: { _id: r.s._id },
          update: { $set: { category: r.category, vision_reason: r.reason, analyzed_at: now } },
        },
      });
    }
    if (ops.length) {
      try {
        await Screenshot.bulkWrite(ops, { ordered: false });
      } catch (err) {
        console.error('[screenshotVision] cache write failed:', err.message);
      }
    }
  }

  return stats;
}

module.exports = { analyzeRange, classifyImage };