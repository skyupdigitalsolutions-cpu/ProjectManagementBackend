const mongoose = require("mongoose");

const DailyReportSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: Date,
      required: true,
      default: () => new Date().setHours(0, 0, 0, 0),
    },
    summary: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    tasks_completed: {
      type: [String],
      default: [],
    },
    blockers: {
      type: String,
      trim: true,
      default: "",
    },
    plan_for_tomorrow: {
      type: String,
      trim: true,
      default: "",
    },
    // Set true once the morning "here's your plan for today" reminder has been
    // sent for this report, so the cron job never notifies the same plan twice.
    plan_reminder_sent: {
      type: Boolean,
      default: false,
    },
    mood: {
      type: String,
      enum: ["great", "good", "okay", "struggling"],
      default: "good",
    },
  },
  { timestamps: true }
);

// One report per user per day
DailyReportSchema.index({ user_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("DailyReport", DailyReportSchema);