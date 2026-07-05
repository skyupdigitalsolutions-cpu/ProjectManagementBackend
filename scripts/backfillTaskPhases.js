/**
 * scripts/backfillTaskPhases.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stamps `phase` + `phase_name` onto existing Task documents based on their title,
 * so the phase-gating UI can show lock badges without re-creating tasks.
 *
 * Gating itself already falls back to title resolution, so this is OPTIONAL —
 * run it if you want the `phase` field persisted on old tasks.
 *
 * RUN:
 *   node scripts/backfillTaskPhases.js            # all projects
 *   node scripts/backfillTaskPhases.js <projectId> # a single project
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Task = require('../models/tasks');
const { resolvePhase, PHASE_NAMES, stampUnlocks } = require('../services/phaseGate');

const MONGO_URI =
  process.env.MONGODB_SEED_URI ||
  process.env.MONGO_URI ||
  'mongodb://127.0.0.1:27017/project-management';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  const projectId = process.argv[2] || null;
  const filter = projectId ? { project_id: projectId } : {};

  const tasks = await Task.find(filter).select('_id title phase').lean();
  console.log(`Scanning ${tasks.length} task(s)...\n`);

  let updated = 0;
  for (const t of tasks) {
    const phase = resolvePhase(t.title);
    if (phase == null) continue;                 // not a website-workflow task
    if (t.phase === phase) continue;             // already correct
    await Task.updateOne(
      { _id: t._id },
      { $set: { phase, phase_name: PHASE_NAMES[phase] } }
    );
    console.log(`  ✓ [P${phase}] ${t.title}`);
    updated += 1;
  }

  console.log(`\nDone. Updated ${updated} task(s).`);

  // Stamp unlock times so the delay clock has a start point for unlocked tasks.
  const projectIds = await Task.find(filter).distinct('project_id');
  let stamped = 0;
  for (const pid of projectIds) stamped += await stampUnlocks(pid);
  console.log(`Stamped unlock time on ${stamped} task(s) across ${projectIds.length} project(s).`);

  await mongoose.disconnect();
}

run().catch((err) => { console.error('Backfill failed:', err); process.exit(1); });