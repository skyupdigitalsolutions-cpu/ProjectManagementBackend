const mongoose = require('mongoose');

/**
 * models/DailyProductivity.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One rolled-up productivity summary per employee per day.
 *
 * This is what the productivity analyzer WRITES (idempotent upsert on
 * user_id + day_key) after combining two independent signals:
 *
 *   1. TITLE signal  — time-weighted productive/neutral/unproductive from
 *                      ActivityLog (app_name + window_title), via the existing
 *                      classificationService.
 *   2. SCREENSHOT signal — a vision model's verdict on each non-idle screenshot
 *                      (productive/neutral/unproductive), from screenshotVision.
 *
 * The two are blended into a single `productive_pct` / `productivity_score`.
 * Every raw number is kept so nothing is hidden and the blend is reproducible.
 *
 * Idempotency: (user_id, day_key) is unique. Re-running the analyzer for a day
 * overwrites the same row instead of creating duplicates.
 */
const dailyProductivitySchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    user_name: { type: String, default: '' }, // denormalized for fast dashboard reads

    // IST calendar day, e.g. "2026-08-22". Human-meaningful + the upsert key.
    day_key: { type: String, required: true },
    // Start-of-day Date used for the aggregation window (matches the digest).
    date: { type: Date, required: true },

    tracked_sec: { type: Number, default: 0 }, // active (non-idle) seconds
    idle_sec: { type: Number, default: 0 },
    first_activity: { type: Date, default: null },
    last_activity: { type: Date, default: null },

    // ── Signal 1: tab titles / app names (time-weighted) ──────────────────────
    title: {
      productive_sec: { type: Number, default: 0 },
      neutral_sec: { type: Number, default: 0 },
      unproductive_sec: { type: Number, default: 0 },
      productive_pct: { type: Number, default: 0 },
    },

    // ── Signal 2: screenshots (vision verdict counts) ─────────────────────────
    screenshots: {
      total: { type: Number, default: 0 },      // screenshots captured that day
      idle_skipped: { type: Number, default: 0 }, // idle shots (not analyzed)
      analyzed: { type: Number, default: 0 },    // non-idle shots actually scored
      productive: { type: Number, default: 0 },
      neutral: { type: Number, default: 0 },
      unproductive: { type: Number, default: 0 },
      productive_pct: { type: Number, default: 0 },
    },

    // ── Blend ─────────────────────────────────────────────────────────────────
    // Final productive % after weighting the two signals (see analyzer).
    productive_pct: { type: Number, default: 0 },
    // 0–100 composite score (currently == productive_pct; kept separate so the
    // scoring formula can evolve without a schema change).
    productivity_score: { type: Number, default: 0 },
    // Which signals actually contributed: 'both' | 'title' | 'screenshot' | 'none'
    blend_basis: { type: String, default: 'none' },

    top_apps: [
      {
        _id: false,
        name: { type: String },
        seconds: { type: Number },
      },
    ],
    projects: [
      {
        _id: false,
        title: { type: String },
        seconds: { type: Number },
      },
    ],
    idle_reasons_count: { type: Number, default: 0 },

    computed_at: { type: Date, default: Date.now },
    method_version: { type: Number, default: 1 }, // bump when the blend changes
  },
  { timestamps: true }
);

// Idempotent upsert key + fast "one employee's history" reads.
dailyProductivitySchema.index({ user_id: 1, day_key: 1 }, { unique: true });
// Company-wide "one day, all employees" reads.
dailyProductivitySchema.index({ day_key: 1 });

module.exports =
  mongoose.models.DailyProductivity ||
  mongoose.model('DailyProductivity', dailyProductivitySchema);