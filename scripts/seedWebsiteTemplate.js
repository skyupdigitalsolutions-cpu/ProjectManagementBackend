/**
 * scripts/seedWebsiteTemplate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates / updates the "Website Development" task template with the full
 * task breakdown, pinning each task to a real employee.
 *
 * ASSIGNMENT RULES (edit the NAMEs below to match your team):
 *   - UI/UX tasks        → UIUX_NAME     (Shashikant S Bilgundi)
 *   - Frontend tasks     → FRONTEND_NAME (Pooja Kadwadi)
 *   - Everything else    → FULLSTACK_NAME (Srinivas Sutar)
 *     (Project Manager, Backend, DevOps, QA — you have no dedicated staff for
 *      these, so they go to a full-stack web developer.)
 *
 * Resolution is by NAME (case-insensitive contains). If a name isn't found it
 * falls back to any active "Full Stack" employee, then to role-only.
 *
 * RUN:
 *   node scripts/seedWebsiteTemplate.js
 * (safe to re-run — upserts the template for projectType "website_development")
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TaskTemplate = require('../models/TaskTemplate');
const User = require('../models/users');

const MONGO_URI =
  process.env.MONGODB_SEED_URI ||
  process.env.MONGO_URI ||
  'mongodb://127.0.0.1:27017/project-management';

// ── EDIT THESE to match the exact names in your Users list ────────────────────
const UIUX_NAME     = 'Shashikant S Bilgundi';
const FRONTEND_NAME = 'Pooja Kadwadi';
const FULLSTACK_NAME = 'Srinivas Sutar';

// ── Task list (role = label; assign = who it goes to) ─────────────────────────
// assign: 'uiux' | 'frontend' | 'fullstack'
const T = (name, role, assign, priority = 'medium', estimatedHours = 16) =>
  ({ name, role, assign, priority, estimatedHours });

const WEBSITE_TASKS = [
  T('Project Kickoff & Scope Definition',                 'Project Manager',   'fullstack', 'high', 16),
  T('UX Research & User Personas',                        'UI/UX Designer',    'uiux',      'high', 16),
  T('Sitemap & Content Inventory (Pages List)',          'UI/UX Designer',    'uiux',      'high', 8),
  T('Technical Architecture Planning',                    'Backend Developer', 'fullstack', 'high', 16),
  T('Wireframing & User Flow Design',                     'UI/UX Designer',    'uiux',      'high', 24),
  T('High-Fidelity UI Mockups (All Screens)',            'UI/UX Designer',    'uiux',      'high', 40),
  T('Design System & Style Guide',                        'UI/UX Designer',    'uiux',      'medium', 16),
  T('Server & Environment Setup',                         'Backend Developer', 'fullstack', 'high', 16),
  T('Database Schema Design',                             'Backend Developer', 'fullstack', 'high', 16),
  T('Authentication & User Management API',               'Backend Developer', 'fullstack', 'high', 24),
  T('Content / CMS API (Pages, Services, Blog)',         'Backend Developer', 'fullstack', 'high', 32),
  T('Contact Form & Lead Capture API',                   'Backend Developer', 'fullstack', 'medium', 16),
  T('Admin Dashboard API Endpoints',                      'Backend Developer', 'fullstack', 'medium', 24),
  T('Third-Party Integrations (Email, Payment, Analytics)', 'Backend Developer', 'fullstack', 'medium', 24),
  T('API Documentation & Backend Testing',                'Backend Developer', 'fullstack', 'medium', 16),
  T('Shared Navigation, Header & Footer',                 'Frontend Developer', 'frontend', 'high', 16),
  T('Homepage Development',                                'Frontend Developer', 'frontend', 'high', 24),
  T('About Us Page',                                      'Frontend Developer', 'frontend', 'medium', 8),
  T('Services / Products Page(s)',                        'Frontend Developer', 'frontend', 'high', 24),
  T('Portfolio / Case Studies Page',                     'Frontend Developer', 'frontend', 'medium', 16),
  T('Blog / News Listing & Detail Pages',                'Frontend Developer', 'frontend', 'medium', 24),
  T('Contact Us Page & Form Integration',                'Frontend Developer', 'frontend', 'high', 16),
  T('Frontend Routing & State Management',               'Frontend Developer', 'frontend', 'medium', 16),
  T('Full API Integration (Connect All Pages to Backend)', 'Frontend Developer', 'frontend', 'high', 32),
  T('Responsive Design & Cross-Browser Testing',         'Frontend Developer', 'frontend', 'medium', 24),
  T('SEO Meta Tags & Schema Setup',                      'Frontend Developer', 'frontend', 'medium', 16),
  T('Functional QA Testing (All Pages & Flows)',         'QA Engineer',       'fullstack', 'high', 24),
  T('Performance & Load Testing',                        'QA Engineer',       'fullstack', 'medium', 16),
  T('Cross-Device & Accessibility Testing',              'QA Engineer',       'fullstack', 'medium', 16),
  T('Bug Fixes & Regression Pass',                       'Full Stack Developer', 'fullstack', 'high', 24),
  T('User Acceptance Testing (UAT)',                     'QA Engineer',       'fullstack', 'high', 16),
  T('Production Deployment & DevOps',                    'DevOps',            'fullstack', 'high', 16),
  T('Post-Launch Monitoring & Bug Fixes',               'Full Stack Developer', 'fullstack', 'medium', 24),
];

async function findByName(name) {
  if (!name) return null;
  return User.findOne({
    role: 'employee',
    name: { $regex: name, $options: 'i' },
  }).select('_id name designation');
}
async function findAnyFullStack() {
  return User.findOne({
    role: 'employee',
    designation: { $regex: 'full ?stack', $options: 'i' },
  }).select('_id name designation');
}
async function findByDesignation(role) {
  if (!role) return null;
  return User.findOne({
    role: 'employee',
    designation: { $regex: role.toLowerCase(), $options: 'i' },
  }).select('_id name designation');
}

async function resolveAssignee(task) {
  if (task.assign === 'uiux') {
    return (await findByName(UIUX_NAME)) || (await findAnyFullStack());
  }
  if (task.assign === 'frontend') {
    return (await findByName(FRONTEND_NAME)) ||
           (await findByDesignation('frontend')) ||
           (await findAnyFullStack());
  }
  // fullstack (default) — PM / Backend / DevOps / QA all go here
  return (await findByName(FULLSTACK_NAME)) || (await findAnyFullStack());
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB\n');

  const tasks = [];
  for (const t of WEBSITE_TASKS) {
    const emp = await resolveAssignee(t);
    if (emp) console.log(`  ✓ ${t.name}\n       → ${emp.name} (${emp.designation})`);
    else     console.log(`  · ${t.name}  → no employee matched (role-only)`);
    tasks.push({
      name: t.name,
      description: null,
      designation: t.role,
      department: null,
      assignedTo: emp ? emp._id : null,
      estimatedHours: t.estimatedHours,
      priority: t.priority,
      subtasks: [],
    });
  }

  const doc = {
    name: 'Website Development',
    projectType: 'website_development',
    description: 'Standard end-to-end website build plan.',
    isActive: true,
    tasks,
  };

  const existing = await TaskTemplate.findOne({ projectType: 'website_development' });
  if (existing) { existing.set(doc); await existing.save(); console.log('\nUpdated "Website Development" template.'); }
  else          { await TaskTemplate.create(doc); console.log('\nCreated "Website Development" template.'); }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => { console.error('Seed failed:', err); process.exit(1); });