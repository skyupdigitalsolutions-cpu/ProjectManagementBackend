/**
 * services/classificationService.js
 *
 * Classifies desktop activity as productive / neutral / unproductive.
 *
 * Order of precedence:
 *   1. Manual overrides (AppCategory where source='manual') — substring match,
 *      highest priority first. These ALWAYS win.
 *   2. AI cache (AppCategory where source='ai') — exact signature lookup.
 *   3. AI call (OpenAI gpt-4o-mini) for anything unseen, result cached.
 *
 * The AI is called at most ONCE per unique signature; every later occurrence
 * uses the cached record, so cost stays near zero.
 *
 * Requires env var: OPENAI_API_KEY
 */

const AppCategory = require('../models/AppCategory');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const VALID = ['productive', 'neutral', 'unproductive'];

// Build a stable cache key from app + a trimmed title hint.
// We keep the app plus the first ~40 chars of the title so that
// "youtube.com" and "jira board" are distinguished, but tiny title
// changes (counts, timestamps) don't create endless new signatures.
function makeSignature(appName, windowTitle) {
  const app = (appName || 'unknown').toLowerCase().trim();
  const title = (windowTitle || '').toLowerCase().trim().slice(0, 40);
  return `${app} | ${title}`;
}

// Try manual overrides first (substring across app + title).
function matchManual(appName, windowTitle, manualRules) {
  const hay = `${appName || ''} ${windowTitle || ''}`.toLowerCase();
  const hit = manualRules.find((r) => r.pattern && hay.includes(r.pattern));
  return hit ? hit.category : null;
}

async function callOpenAI(appName, windowTitle) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return 'neutral'; // no key -> safe default, no crash

  const prompt =
    `Classify this desktop activity for an employee at a digital marketing and ` +
    `web development agency as exactly one word: "productive", "neutral", or "unproductive".\n\n` +
    `PRODUCTIVE = work tools and work content: coding/IDE, design tools, documents, ` +
    `spreadsheets, email, project management, databases, terminals, developer docs, ` +
    `Stack Overflow, GitHub, client websites, business/marketing research, work-related AI chats.\n\n` +
    `UNPRODUCTIVE = entertainment and personal use, regardless of which app or browser shows it. ` +
    `Judge by the CONTENT in the title, not just the app name. Treat as unproductive:\n` +
    `- Music or video titles (song names, artist names, "(full song)", "official video", ` +
    `"lyrics", track durations, a leading "(number)" which is a YouTube notification count)\n` +
    `- Movies, web series, streaming (Netflix, Prime, Hotstar, YouTube entertainment)\n` +
    `- Games, social media feeds, memes, sports scores, online shopping for personal items\n\n` +
    `NEUTRAL = genuinely ambiguous, blank, "new tab", file explorer, system notifications, ` +
    `or general chat apps used for coordination.\n\n` +
    `Important: a song or video playing in a web browser is UNPRODUCTIVE even though the ` +
    `browser is a work tool. Look at what is actually on screen.\n\n` +
    `App: ${appName || 'unknown'}\nWindow title: ${windowTitle || '(none)'}\n` +
    `Answer with only one word.`;

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      console.error('OpenAI classify failed:', res.status);
      return 'neutral';
    }
    const data = await res.json();
    const answer = (data.choices?.[0]?.message?.content || '').toLowerCase().trim();
    const found = VALID.find((v) => answer.includes(v));
    return found || 'neutral';
  } catch (err) {
    console.error('OpenAI classify error:', err.message);
    return 'neutral';
  }
}

/**
 * Classify a batch of {app_name, window_title} pairs.
 * Returns a Map keyed by makeSignature() -> category.
 * Fills the AppCategory AI cache for any new signatures.
 *
 * NON-BLOCKING: unknown signatures are returned as 'neutral' immediately and
 * classified in the BACKGROUND (fired in parallel, not awaited). This means the
 * dashboard never waits on OpenAI — the first time a new app appears it shows as
 * neutral, and by the next load it's correctly categorized and cached.
 */
async function classifyBatch(pairs) {
  const manualRules = await AppCategory.find({ is_active: true, source: 'manual' })
    .sort({ priority: -1 })
    .lean();

  // Unique signatures in this batch
  const bySig = new Map();
  for (const p of pairs) {
    const sig = makeSignature(p.app_name, p.window_title);
    if (!bySig.has(sig)) bySig.set(sig, p);
  }

  // Load existing AI cache for these signatures
  const sigs = [...bySig.keys()];
  const cached = await AppCategory.find({ signature: { $in: sigs }, source: 'ai' }).lean();
  const cacheMap = new Map(cached.map((c) => [c.signature, c.category]));

  const result = new Map();
  const toClassify = [];

  for (const [sig, p] of bySig) {
    // 1. Manual override wins
    const manual = matchManual(p.app_name, p.window_title, manualRules);
    if (manual) { result.set(sig, manual); continue; }

    // 2. AI cache hit
    if (cacheMap.has(sig)) { result.set(sig, cacheMap.get(sig)); continue; }

    // 3. Unknown -> return neutral NOW, queue for background classification
    result.set(sig, 'neutral');
    toClassify.push({ sig, p });
  }

  // Fire background classification (parallel, NOT awaited) so the response
  // returns instantly. Results are cached for the next load.
  if (toClassify.length) {
    Promise.allSettled(
      toClassify.map(async ({ sig, p }) => {
        const category = await callOpenAI(p.app_name, p.window_title);
        try {
          await AppCategory.updateOne(
            { signature: sig },
            { $set: { signature: sig, category, source: 'ai', is_active: true, priority: 1 } },
            { upsert: true }
          );
        } catch (err) {
          if (err.code !== 11000) console.error('cache write error:', err.message);
        }
      })
    ).catch(() => {}); // never let background work crash the process
  }

  return { result, makeSignature };
}

module.exports = { classifyBatch, makeSignature };