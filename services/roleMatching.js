/**
 * services/roleMatching.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for "which employee designations are allowed to pick
 * up a task that requires role X". Used by every auto-assign code path
 * (adaptiveAssignmentEngine, Assignmentcontroller's MODE C fallback, and
 * autoAssignForProject) so they all agree on the same rules instead of each
 * having its own slightly-different fuzzy matching that can drift out of sync.
 *
 * WHY THIS EXISTS (not just generic word-overlap):
 * Plain "any shared word" matching (e.g. matching on the word "developer")
 * is too loose — it lets an "AI Developer" or any other "* Developer" title
 * pick up website/backend/frontend tasks just because they share the word
 * "developer". This file instead groups designations into explicit families
 * and maps each required_role to the specific families allowed to do it —
 * so "backend developer" tasks only go to Backend/Full-Stack designations,
 * never AI/ML, marketing, or other unrelated titles.
 */

// ─── Designation families ─────────────────────────────────────────────────────
// Keyword lists checked against an employee's `designation` (lowercased).
// Short/ambiguous tokens (ai, ux, qa) use word-boundary regex to avoid false
// hits inside unrelated words.
const FAMILY_PATTERNS = {
  frontend:   [/frontend/, /front[\s-]?end/],
  backend:    [/backend/, /back[\s-]?end/, /server\s*developer/],
  fullstack:  [/full[\s-]?stack/],
  mobile:     [/mobile\s*developer/, /android\s*developer/, /ios\s*developer/, /app\s*developer/],
  design:     [/designer/, /\bux\b/, /ui\/ux/, /ui\s*designer/],
  qa:         [/\bqa\b/, /quality\s*assurance/, /quality\s*analyst/, /\btester\b/],
  seo:        [/\bseo\b/],
  marketing:  [/marketing/],
  content:    [/content\s*writer/, /content\s*specialist/, /content\s*creator/],
  ai_ml:      [/\bai\b/, /machine\s*learning/, /\bml\b/, /data\s*scientist/],
  automation: [/automation/],
  data:       [/data\s*analyst/, /data\s*engineer/],
  devops:     [/devops/],
  brand:      [/brand/],
  pm:         [/project\s*manager/, /program\s*manager/],
};

// ─── required_role → which designation families may take it ──────────────────
// A role can allow more than one family (e.g. backend work can go to a
// Backend Developer OR a Full Stack Web Developer, per SkyUp's actual team
// structure — but explicitly NOT to AI/ML or Frontend-only designations).
const ROLE_FAMILY_RULES = [
  { test: /full[\s-]?stack/,                 families: ["fullstack"] },
  { test: /backend|server|api|database/,     families: ["backend", "fullstack"] },
  { test: /frontend|front[\s-]?end/,         families: ["frontend", "fullstack"] },
  { test: /mobile|android|ios|app\s*dev/,    families: ["mobile", "fullstack"] },
  { test: /devops/,                          families: ["devops", "backend", "fullstack"] },
  { test: /ui\/ux|ux|ui\s*design|designer/,  families: ["design"] },
  { test: /graphic/,                         families: ["design"] },
  { test: /brand/,                           families: ["brand", "design"] },
  { test: /qa|quality|test/,                 families: ["qa"] },
  { test: /seo/,                             families: ["seo"] },
  { test: /google\s*ads/,                    families: ["marketing"] },
  { test: /email\s*marketing/,               families: ["marketing"] },
  { test: /marketing/,                       families: ["marketing"] },
  { test: /content/,                         families: ["content"] },
  { test: /automation/,                      families: ["automation"] },
  { test: /machine\s*learning|\bml\b|\bai\b/, families: ["ai_ml"] },
  { test: /data\s*analy|data\s*engineer/,    families: ["data"] },
  { test: /project\s*manager/,               families: ["pm"] },
];

/**
 * Resolve which designation families are allowed to take on a given
 * required_role string (e.g. "backend developer", "Frontend Developer").
 * Falls back to an empty array (meaning: no family-based restriction found —
 * caller should fall back to looser matching) if nothing matches.
 */
function getEligibleFamilies(requiredRole = "") {
  const role = String(requiredRole || "").toLowerCase();
  if (!role) return [];
  const matched = new Set();
  for (const rule of ROLE_FAMILY_RULES) {
    if (rule.test.test(role)) rule.families.forEach((f) => matched.add(f));
  }
  return Array.from(matched);
}

/**
 * Does this employee's designation belong to at least one of the given
 * families?
 */
function designationInFamilies(designation = "", families = []) {
  const desig = String(designation || "").toLowerCase();
  if (!desig || !families.length) return false;
  return families.some((fam) => {
    const patterns = FAMILY_PATTERNS[fam];
    if (!patterns) return false;
    return patterns.some((p) => p.test(desig));
  });
}

/**
 * Main entry point: does this employee's designation qualify for this
 * required_role, under SkyUp's actual team structure (e.g. Full Stack Web
 * Developer covers both backend and frontend work; AI Developer only covers
 * AI/ML work, never generic web dev tasks)?
 *
 * If the required_role doesn't match any known family rule at all, this
 * falls back to permissive single-word overlap (so brand-new/unusual role
 * strings someone types manually still have a chance to match someone,
 * rather than silently locking everyone out).
 */
function designationMatchesRole(designation, requiredRole) {
  const families = getEligibleFamilies(requiredRole);
  if (families.length > 0) {
    return designationInFamilies(designation, families);
  }
  // Fallback: loose word overlap for roles we don't have an explicit rule for.
  const words = String(requiredRole || "")
    .toLowerCase()
    .split(/[\s/\-_,]+/)
    .filter((w) => w.length > 2);
  const desig = String(designation || "").toLowerCase();
  return words.some((w) => desig.includes(w));
}

module.exports = {
  getEligibleFamilies,
  designationInFamilies,
  designationMatchesRole,
  FAMILY_PATTERNS,
  ROLE_FAMILY_RULES,
};