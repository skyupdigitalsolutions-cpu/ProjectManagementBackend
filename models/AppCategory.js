const mongoose = require('mongoose');

/**
 * Maps apps / window-title keywords to a productivity category.
 * `pattern` is matched as a case-insensitive substring against
 * app_name first, then window_title. First match wins by `priority`.
 *
 * Seed examples:
 *   { pattern: 'code',      category: 'productive',   priority: 10 }
 *   { pattern: 'figma',     category: 'productive',   priority: 10 }
 *   { pattern: 'localhost', category: 'productive',   priority: 20 }
 *   { pattern: 'slack',     category: 'neutral',      priority: 10 }
 *   { pattern: 'youtube',   category: 'unproductive', priority: 20 }
 */
const appCategorySchema = new mongoose.Schema(
  {
    pattern: { type: String, required: true, trim: true, lowercase: true },
    category: {
      type: String,
      enum: ['productive', 'neutral', 'unproductive'],
      required: true
    },
    // Optional role scoping, e.g. 'designer' -> Canva productive for designers only
    role: { type: String, default: null },
    priority: { type: Number, default: 10 },
    is_active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

appCategorySchema.index({ is_active: 1, priority: -1 });

module.exports = mongoose.model('AppCategory', appCategorySchema);