/**
 * services/phaseGate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase-based task gating for the Website Development workflow.
 *
 * Flow enforced:
 *   Phase 1  Design & Planning        (UI/UX: research, wireframes, mockups, design system, architecture)
 *   Phase 2  Development              (frontend + backend — worked in parallel)
 *   Phase 3  Testing & Deployment     (QA, UAT, Production Deployment & DevOps, Post-Launch Monitoring)
 *
 * Rule: a task in phase N cannot be updated until EVERY task in the same project
 * belonging to an EARLIER phase (< N) is completed or cancelled.
 *
 * Phase is read from task.phase when present (set by the seed/template), and
 * otherwise resolved from the task title so it also works for older tasks that
 * were created before the `phase` field existed. Tasks whose phase cannot be
 * resolved (e.g. non-website projects) are never locked.
 */

const Task = require('../models/tasks');

const PHASE_NAMES = {
  1: 'Design & Planning',
  2: 'Development',
  3: 'Testing & Deployment',
};

// First matching rule wins. Phase 3 is tested first so combined titles like
// "Bug Fixes & Regression Pass" resolve to testing, not development.
const PHASE_RULES = [
  {
    phase: 3,
    re: /(qa testing|functional qa|performance ?& ?load|load testing|accessibility testing|regression|bug ?fix|user acceptance|uat|production deployment|dev ?ops|post-?launch|monitoring)/i,
  },
  {
    phase: 1,
    re: /(kickoff|scope|ux research|user personas|sitemap|content inventory|wireframe|user flow|ui mockup|hi-?fi|high-?fidelity|design system|style guide|technical architecture)/i,
  },
  {
    phase: 2,
    re: /(environment setup|server ?& ?environment|database schema|authentication|user management|cms|content .*api|lead capture|admin dashboard api|third-?party integration|api documentation|backend testing|navigation|header ?& ?footer|homepage|about us|services?|products?|portfolio|case stud|blog|news|contact us|routing|state management|api integration|responsive design|cross-?browser|seo meta|schema setup)/i,
  },
];

/** Resolve a phase number (1|2|3) from a task title, or null if unknown. */
function resolvePhase(title) {
  if (!title) return null;
  for (const rule of PHASE_RULES) {
    if (rule.re.test(title)) return rule.phase;
  }
  return null;
}

/** Phase of a single task doc/obj: stored value wins, else derived from title. */
function phaseOf(task) {
  if (task == null) return null;
  if (task.phase != null) return task.phase;
  return resolvePhase(task.title);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Allotted duration of a task, in whole days (min 1). */
function durationDays(task) {
  if (task.estimated_days != null && task.estimated_days > 0) return Math.ceil(task.estimated_days);
  if (task.estimated_hours != null && task.estimated_hours > 0) return Math.max(1, Math.ceil(task.estimated_hours / 8));
  return 1;
}

// ── Working-day config (weekly offs + holidays) from the active Policy ─────────
const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

let _cfgCache = null;
let _cfgAt = 0;
const CFG_TTL_MS = 5 * 60 * 1000;

/**
 * Load weekly-off days + holiday dates from the active Policy (cached 5 min).
 * Falls back to Sat/Sun and no holidays if no policy is found.
 * @returns {Promise<{weeklyOffs:Set<number>, holidays:Set<string>}>}
 */
async function getWorkingDayConfig() {
  const now = Date.now();
  if (_cfgCache && now - _cfgAt < CFG_TTL_MS) return _cfgCache;

  let weeklyOffs = new Set([0, 6]); // 0=Sun … 6=Sat
  const holidays = new Set();
  try {
    const Policy = require('../models/policy');
    const p = await Policy.findOne({ is_active: true }).select('weekly_offs holidays').lean();
    if (p) {
      if (Array.isArray(p.weekly_offs) && p.weekly_offs.length) weeklyOffs = new Set(p.weekly_offs);
      if (Array.isArray(p.holidays)) {
        for (const h of p.holidays) if (h?.date) holidays.add(ymd(new Date(h.date)));
      }
    }
  } catch (_) { /* keep defaults */ }

  _cfgCache = { weeklyOffs, holidays };
  _cfgAt = now;
  return _cfgCache;
}

function isWorkingDay(date, cfg) {
  if (!cfg) return true;
  if (cfg.weeklyOffs.has(date.getDay())) return false;
  if (cfg.holidays.has(ymd(date))) return false;
  return true;
}

/**
 * Advance `days` WORKING days from `start` (skipping weekly-offs + holidays),
 * preserving the start's time-of-day. If cfg is omitted, falls back to plain
 * calendar days. The unlock day itself counts as working-day #1 when it's a
 * working day.
 */
function addWorkingDays(start, days, cfg) {
  const need = Math.max(1, Math.ceil(days));
  if (!cfg) return new Date(new Date(start).getTime() + need * DAY_MS);

  const d = new Date(start);
  let counted = 0;
  let guard = 0;
  while (guard++ < 3650) {
    if (isWorkingDay(d, cfg)) {
      counted += 1;
      if (counted >= need) break;
    }
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Effective deadline for delay purposes = unlocked_at + duration (working days).
 * Returns null if the task hasn't been unlocked yet (so it can't be "delayed").
 * Pass a cfg from getWorkingDayConfig() to honour weekly-offs + holidays.
 */
function effectiveDueDate(task, cfg = null) {
  if (!task.unlocked_at) return null;
  return addWorkingDays(new Date(task.unlocked_at), durationDays(task), cfg);
}

/**
 * Compute lock state for ONE task.
 * @returns {Promise<{locked:boolean, phase:(number|null), phase_name:(string|null), reason:(string|null), remaining:number}>}
 */
async function getLockState(task) {
  const phase = phaseOf(task);
  const base = { locked: false, phase, phase_name: phase ? PHASE_NAMES[phase] : null, reason: null, remaining: 0 };
  if (!phase || phase <= 1) return base;

  const projectId = task.project_id?._id || task.project_id;
  if (!projectId) return base;

  const siblings = await Task.find({ project_id: projectId })
    .select('title phase status')
    .lean();

  let remaining = 0;
  let blockingPhase = null;
  for (const s of siblings) {
    const p = phaseOf(s);
    if (p == null || p >= phase) continue;                 // same/later/unknown — not a prerequisite
    if (['completed', 'cancelled'].includes(s.status)) continue;
    remaining += 1;
    if (blockingPhase == null || p < blockingPhase) blockingPhase = p;
  }

  if (remaining === 0) return base;

  return {
    ...base,
    locked: true,
    reason: `Locked — complete all "${PHASE_NAMES[blockingPhase] || 'earlier phase'}" tasks first (${remaining} remaining).`,
    remaining,
  };
}

/**
 * Batch-annotate an array of task docs with { phase, phase_name, is_locked,
 * lock_reason }. Runs ONE extra query (all tasks of the involved projects) so it
 * works even for employees who can only see their own tasks in the page.
 * Returns plain objects (safe to send as JSON).
 */
async function annotateLockState(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;

  const pidOf = (t) => (t.project_id?._id || t.project_id)?.toString();
  const projectIds = [...new Set(tasks.map(pidOf).filter(Boolean))];
  if (projectIds.length === 0) {
    return tasks.map((t) => {
      const o = t.toObject ? t.toObject() : { ...t };
      const phase = phaseOf(t);
      o.phase = phase; o.phase_name = phase ? PHASE_NAMES[phase] : null;
      o.is_locked = false; o.lock_reason = null;
      return o;
    });
  }

  const all = await Task.find({ project_id: { $in: projectIds } })
    .select('project_id title phase status')
    .lean();

  const cfg = await getWorkingDayConfig();

  // project -> phase -> incomplete count
  const byProject = new Map();
  for (const s of all) {
    const pid = s.project_id.toString();
    const p = phaseOf(s);
    if (p == null) continue;
    if (!byProject.has(pid)) byProject.set(pid, new Map());
    const phaseMap = byProject.get(pid);
    const rec = phaseMap.get(p) || { incomplete: 0 };
    if (!['completed', 'cancelled'].includes(s.status)) rec.incomplete += 1;
    phaseMap.set(p, rec);
  }

  return tasks.map((t) => {
    const o = t.toObject ? t.toObject() : { ...t };
    const pid = pidOf(t);
    const phase = phaseOf(t);
    o.phase = phase;
    o.phase_name = phase ? PHASE_NAMES[phase] : null;
    o.is_locked = false;
    o.lock_reason = null;

    if (phase && phase > 1 && pid && byProject.has(pid)) {
      const phaseMap = byProject.get(pid);
      let remaining = 0;
      let blockingPhase = null;
      for (const [p, rec] of phaseMap.entries()) {
        if (p < phase && rec.incomplete > 0) {
          remaining += rec.incomplete;
          if (blockingPhase == null || p < blockingPhase) blockingPhase = p;
        }
      }
      if (remaining > 0) {
        o.is_locked = true;
        o.lock_reason = `Locked — complete all "${PHASE_NAMES[blockingPhase]}" tasks first (${remaining} remaining).`;
      }
    }
    // Delay clock only runs once unlocked; locked tasks have no effective deadline.
    o.effective_due_date = o.is_locked ? null : effectiveDueDate(o, cfg);
    return o;
  });
}

/**
 * Stamp `unlocked_at` on any task in a project that is currently unlocked but
 * hasn't been stamped yet. Call after a task completes (which may unlock later
 * phases). Idempotent — never overwrites an existing unlocked_at.
 * Phase 1 / unphased tasks are unlocked from their start (start_date/createdAt);
 * later phases are stamped at the moment they unlock (now).
 */
async function stampUnlocks(projectId) {
  if (!projectId) return 0;

  const tasks = await Task.find({ project_id: projectId })
    .select('title phase status unlocked_at start_date createdAt')
    .lean();

  // phase -> incomplete count (to know which phases are fully done)
  const incompleteByPhase = new Map();
  for (const s of tasks) {
    const p = phaseOf(s);
    if (p == null) continue;
    const cur = incompleteByPhase.get(p) || 0;
    if (!['completed', 'cancelled'].includes(s.status)) incompleteByPhase.set(p, cur + 1);
    else if (!incompleteByPhase.has(p)) incompleteByPhase.set(p, 0);
  }

  const now = new Date();
  const ops = [];
  for (const t of tasks) {
    if (t.unlocked_at) continue;
    const phase = phaseOf(t);

    // Is it locked? (any earlier phase still incomplete)
    let locked = false;
    if (phase && phase > 1) {
      for (const [p, incomplete] of incompleteByPhase.entries()) {
        if (p < phase && incomplete > 0) { locked = true; break; }
      }
    }
    if (locked) continue;

    const when = (phase == null || phase <= 1)
      ? (t.start_date || t.createdAt || now)
      : now;
    ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: { unlocked_at: when } } } });
  }

  if (ops.length) await Task.bulkWrite(ops);
  return ops.length;
}

module.exports = {
  PHASE_NAMES,
  resolvePhase,
  phaseOf,
  durationDays,
  effectiveDueDate,
  getWorkingDayConfig,
  addWorkingDays,
  getLockState,
  annotateLockState,
  stampUnlocks,
};