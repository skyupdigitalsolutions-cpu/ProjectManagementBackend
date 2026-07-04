/**
 * scripts/seedWebsiteTemplate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates (or updates) the "Website Development" task template.
 *
 * WHY A SCRIPT (not hardcoded IDs): pinning a task to a specific employee
 * needs that employee's real _id, which only exists in YOUR database. This
 * script matches each task's role to an active employee by designation (then
 * department) at run time and pins them. Any task with no match is left as
 * role-only (auto-matched later, or assign manually in the UI).
 *
 * RUN ONCE:
 *   node scripts/seedWebsiteTemplate.js
 *
 * It is safe to re-run: it upserts the template for projectType
 * "website_development".
 *
 * AFTER RUNNING: open Admin → Task Templates → Website Development to review
 * and, if you want different people, change the "Assign to" dropdown per task.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const TaskTemplate = require('../models/TaskTemplate');
const User = require('../models/users');

// Connection: prefer an explicit seed override (used to bypass local SRV/DNS
// issues with a non-"+srv" connection string), then MONGO_URI, then localhost.
const MONGO_URI =
  process.env.MONGODB_SEED_URI ||
  process.env.MONGO_URI ||
  'mongodb://127.0.0.1:27017/project-management';

// ── The Website Development plan ──────────────────────────────────────────────
// Edit freely: names, roles, hours, priorities, subtasks. `role` is used to
// find a matching employee to pin; if none is found the task stays role-only.
const WEBSITE_TASKS = [
  {
    name: 'Requirements Gathering & SRS',
    description: 'Collect client requirements and document the scope in an SRS.',
    role: 'Business Analyst',
    estimatedHours: 24,
    priority: 'high',
    subtasks: ['Client kickoff call', 'Document functional requirements', 'Get SRS sign-off'],
  },
  {
    name: 'Wireframes & UI/UX Design',
    description: 'Design wireframes and high-fidelity mockups for all pages.',
    role: 'UI/UX Designer',
    estimatedHours: 40,
    priority: 'high',
    subtasks: ['Sitemap & page list', 'Wireframes', 'High-fidelity mockups', 'Design review'],
  },
  {
    name: 'Project Setup & CI/CD',
    description: 'Initialise the repository, tooling, and deployment pipeline.',
    role: 'DevOps Engineer',
    estimatedHours: 16,
    priority: 'medium',
    subtasks: ['Create repo & branch strategy', 'Configure CI/CD pipeline'],
  },
  {
    name: 'Frontend Development',
    description: 'Build all pages and components to match the approved design.',
    role: 'Frontend Developer',
    estimatedHours: 80,
    priority: 'high',
    subtasks: ['Layout & shared components', 'Page-by-page build', 'Responsive/mobile pass', 'Form validation'],
  },
  {
    name: 'Backend API Development',
    description: 'Build the APIs, business logic, and integrations.',
    role: 'Backend Developer',
    estimatedHours: 80,
    priority: 'high',
    subtasks: ['API endpoints', 'Auth & permissions', 'Third-party integrations'],
  },
  {
    name: 'Database Design & Setup',
    description: 'Design schema, relationships, and indexes.',
    role: 'Backend Developer',
    estimatedHours: 24,
    priority: 'medium',
    subtasks: ['Schema design', 'Seed & migrations'],
  },
  {
    name: 'SEO Optimisation',
    description: 'On-page SEO, meta tags, sitemap, and performance for search.',
    role: 'SEO Specialist',
    estimatedHours: 24,
    priority: 'medium',
    subtasks: ['Meta tags & structured data', 'Sitemap & robots', 'Core Web Vitals pass'],
  },
  {
    name: 'QA & Cross-Browser Testing',
    description: 'Functional, cross-browser, and regression testing.',
    role: 'QA Engineer',
    estimatedHours: 40,
    priority: 'high',
    subtasks: ['Test plan', 'Cross-browser testing', 'Bug logging & retest'],
  },
  {
    name: 'UAT & Client Sign-off',
    description: 'Client acceptance testing and final fixes.',
    role: 'Project Manager',
    estimatedHours: 24,
    priority: 'high',
    subtasks: ['UAT session', 'Fix UAT feedback', 'Get sign-off'],
  },
  {
    name: 'Deployment & Go-Live',
    description: 'Production deployment, DNS, monitoring, and handover.',
    role: 'DevOps Engineer',
    estimatedHours: 16,
    priority: 'critical',
    subtasks: ['Production deploy', 'DNS & SSL', 'Post-launch monitoring'],
  },
];

async function findEmployeeByRole(role) {
  if (!role) return null;
  const rx = { $regex: role.toLowerCase(), $options: 'i' };
  return (
    (await User.findOne({ role: 'employee', status: 'active', designation: rx }).select('_id name designation')) ||
    (await User.findOne({ role: 'employee', status: 'active', department: rx }).select('_id name designation')) ||
    null
  );
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  const tasks = [];
  for (const t of WEBSITE_TASKS) {
    const emp = await findEmployeeByRole(t.role);
    if (emp) {
      console.log(`  ✓ "${t.name}" → ${emp.name} (${emp.designation})`);
    } else {
      console.log(`  · "${t.name}" → no employee matched role "${t.role}" (left role-only)`);
    }
    tasks.push({
      name: t.name,
      description: t.description,
      designation: t.role,
      department: null,
      assignedTo: emp ? emp._id : null,
      estimatedHours: t.estimatedHours,
      priority: t.priority,
      subtasks: (t.subtasks || []).map((s) => ({ name: s })),
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
  if (existing) {
    existing.set(doc);
    await existing.save();
    console.log('\nUpdated existing "Website Development" template.');
  } else {
    await TaskTemplate.create(doc);
    console.log('\nCreated "Website Development" template.');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});