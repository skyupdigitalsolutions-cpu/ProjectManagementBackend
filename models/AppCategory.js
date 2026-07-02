const mongoose = require('mongoose');

/**
 * Maps apps / window-title keywords to a productivity category.
 *
 * TWO kinds of records:
 *  - Manual overrides (source: 'manual'): matched as a case-insensitive
 *    SUBSTRING against "app_name + window_title", highest priority first.
 *    These always win.
 *  - AI cache (source: 'ai'): one record per unique classified signature,
 *    filled automatically by the classification service. Looked up by exact
 *    `signature`, not substring.
 */
const appCategorySchema = new mongoose.Schema(
  {
    // Manual override matching (substring). Optional for AI records.
    pattern: { type: String, trim: true, lowercase: true, default: null },

    // AI cache key: normalized "app | title-hint". Unique when present.
    signature: { type: String, trim: true, default: null, index: true },

    category: {
      type: String,
      enum: ['productive', 'neutral', 'unproductive'],
      required: true,
    },
    source: { type: String, enum: ['manual', 'ai'], default: 'manual' },
    role: { type: String, default: null },
    priority: { type: Number, default: 10 },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

appCategorySchema.index({ is_active: 1, priority: -1 });
appCategorySchema.index({ signature: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.AppCategory || mongoose.model('AppCategory', appCategorySchema);