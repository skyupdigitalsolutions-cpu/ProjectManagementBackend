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
    `web development agency as exactly one word: "productive", "neutral", or "unproductive".\n` +
    `Productive = work tools (coding, design, docs, email, project tools, client sites, research).\n` +
    `Unproductive = entertainment/social (video streaming, games, social media, shopping for fun).\n` +
    `Neutral = anything ambiguous or general.\n` +
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

  for (const [sig, p] of bySig) {
    // 1. Manual override wins
    const manual = matchManual(p.app_name, p.window_title, manualRules);
    if (manual) { result.set(sig, manual); continue; }

    // 2. AI cache hit
    if (cacheMap.has(sig)) { result.set(sig, cacheMap.get(sig)); continue; }

    // 3. Call AI once, then cache
    const category = await callOpenAI(p.app_name, p.window_title);
    result.set(sig, category);
    try {
      await AppCategory.updateOne(
        { signature: sig },
        { $set: { signature: sig, category, source: 'ai', is_active: true, priority: 1 } },
        { upsert: true }
      );
    } catch (err) {
      // Duplicate-key race is fine; another request cached it first.
      if (err.code !== 11000) console.error('cache write error:', err.message);
    }
  }

  return { result, makeSignature };
}

module.exports = { classifyBatch, makeSignature };