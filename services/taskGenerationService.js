const DEFAULT_DAILY_HOURS = 8;

// ─── Assignment Type → Subtask Templates ────────────────────────────────────
const ASSIGNMENT_TASK_TEMPLATES = {
  Design: [
    {
      title: "UX Research & User Flows",
      description: "Conduct user research, create personas, and map user journeys",
      required_role: "designer",
      required_department: "Design",
      estimatedHours: 6,
      priority: "high",
    },
    {
      title: "Wireframing & Prototyping",
      description: "Create low-fidelity wireframes and interactive prototypes",
      required_role: "designer",
      required_department: "Design",
      estimatedHours: 8,
      priority: "high",
    },
    {
      title: "UI Design – Screens",
      description: "Design all application screens with consistent design system",
      required_role: "designer",
      required_department: "Design",
      estimatedHours: 10,
      priority: "medium",
    },
    {
      title: "UI Design – Components",
      description: "Build reusable component library (buttons, cards, forms, etc.)",
      required_role: "designer",
      required_department: "Design",
      estimatedHours: 6,
      priority: "medium",
    },
    {
      title: "Design Review & Handoff",
      description: "Finalize designs, create developer handoff specs and assets",
      required_role: "designer",
      required_department: "Design",
      estimatedHours: 4,
      priority: "low",
    },
  ],

  Development: [
    {
      title: "Project Setup & Architecture",
      description: "Initialize repo, configure CI/CD, define folder structure and tech stack",
      required_role: "backend developer",
      required_department: "Web Development",
      estimatedHours: 4,
      priority: "high",
    },
    {
      title: "Database Schema Design",
      description: "Design and implement database models, relationships, and indexes",
      required_role: "backend developer",
      required_department: "Web Development",
      estimatedHours: 5,
      priority: "high",
    },
    {
      title: "API Development",
      description: "Build RESTful APIs – authentication, CRUD operations, business logic",
      required_role: "backend developer",
      required_department: "Web Development",
      estimatedHours: 8,
      priority: "high",
    },
    {
      title: "Frontend Integration",
      description: "Connect React/Vue frontend to backend APIs, handle state management",
      required_role: "frontend developer",
      required_department: "Web Development",
      estimatedHours: 8,
      priority: "medium",
    },
    {
      title: "Authentication & Authorization",
      description: "Implement JWT auth, role-based access control, and session management",
      required_role: "backend developer",
      required_department: "Web Development",
      estimatedHours: 5,
      priority: "high",
    },
    {
      title: "Unit & Integration Testing",
      description: "Write tests for core modules, achieve minimum 70% code coverage",
      required_role: "backend developer",
      required_department: "Web Development",
      estimatedHours: 6,
      priority: "medium",
    },
    {
      title: "Deployment & DevOps",
      description: "Configure server, deploy to production, set up monitoring and logging",
      required_role: "backend developer",
      required_department: "Web Development",
      estimatedHours: 4,
      priority: "low",
    },
  ],

  Testing: [
    {
      title: "Test Plan & Strategy",
      description: "Define test scope, types, tools, and acceptance criteria",
      required_role: "qa engineer",
      required_department: "Testing",
      estimatedHours: 3,
      priority: "high",
    },
    {
      title: "Functional Testing",
      description: "Test all features against requirements – manual and exploratory testing",
      required_role: "qa engineer",
      required_department: "Testing",
      estimatedHours: 6,
      priority: "high",
    },
    {
      title: "Regression Testing",
      description: "Ensure new changes do not break existing functionality",
      required_role: "qa engineer",
      required_department: "Testing",
      estimatedHours: 4,
      priority: "medium",
    },
    {
      title: "Performance & Load Testing",
      description: "Benchmark API response times and system behavior under load",
      required_role: "qa engineer",
      required_department: "Testing",
      estimatedHours: 4,
      priority: "medium",
    },
    {
      title: "Bug Reporting & Tracking",
      description: "Document, prioritize, and track all identified defects",
      required_role: "qa engineer",
      required_department: "Testing",
      estimatedHours: 3,
      priority: "medium",
    },
    {
      title: "UAT – User Acceptance Testing",
      description: "Coordinate UAT sessions with stakeholders, collect sign-off",
      required_role: "qa engineer",
      required_department: "Testing",
      estimatedHours: 4,
      priority: "low",
    },
  ],

  Marketing: [
    {
      title: "Market Research & Competitor Analysis",
      description: "Analyze target audience, market trends, and competitor strategies",
      required_role: "marketing specialist",
      required_department: "Marketing",
      estimatedHours: 5,
      priority: "high",
    },
    {
      title: "Campaign Strategy & Roadmap",
      description: "Define campaign goals, KPIs, channels, and messaging framework",
      required_role: "marketing specialist",
      required_department: "Marketing",
      estimatedHours: 4,
      priority: "high",
    },
    {
      title: "Content Creation – Copy & Assets",
      description: "Write copy, design visuals, and produce marketing collateral",
      required_role: "content writer",
      required_department: "Content Marketing",
      estimatedHours: 8,
      priority: "medium",
    },
    {
      title: "Social Media Setup & Scheduling",
      description: "Create and schedule posts across platforms, configure ad campaigns",
      required_role: "marketing specialist",
      required_department: "Marketing",
      estimatedHours: 5,
      priority: "medium",
    },
    {
      title: "SEO Optimization",
      description: "Keyword research, on-page SEO, meta tags, and content optimization",
      required_role: "seo specialist",
      required_department: "SEO",
      estimatedHours: 6,
      priority: "medium",
    },
    {
      title: "Analytics Setup & Reporting",
      description: "Configure GA4, conversion tracking, and create performance dashboards",
      required_role: "marketing specialist",
      required_department: "Marketing",
      estimatedHours: 4,
      priority: "low",
    },
  ],
};

// ─── Priority sort order ──────────────────────────────────────────────────────
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, critical: -1 };

/**
 * Generate task drafts for a given assignment type.
 */
function generateTasksForAssignment(
  assignmentType,
  parentPriority = "medium",
  dailyWorkHours = DEFAULT_DAILY_HOURS
) {
  const templates = ASSIGNMENT_TASK_TEMPLATES[assignmentType];
  if (!templates) {
    throw new Error(
      `Unknown assignment type: "${assignmentType}". Valid types: ${Object.keys(
        ASSIGNMENT_TASK_TEMPLATES
      ).join(", ")}`
    );
  }

  const shouldInheritPriority =
    parentPriority === "high" || parentPriority === "critical";

  const drafts = templates.map((template) => {
    const effectivePriority = shouldInheritPriority
      ? parentPriority
      : template.priority;

    const estimatedDays = Math.ceil(template.estimatedHours / dailyWorkHours);

    return {
      title: template.title,
      description: template.description,
      required_role: template.required_role,
      required_department: template.required_department,
      estimatedHours: template.estimatedHours,
      estimated_days: estimatedDays,
      priority: effectivePriority,
      assignedDate: null,
      expectedCompletionDate: null,
      status: "pending",
    };
  });

  drafts.sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
  );

  return drafts;
}

/**
 * Get just the template list for a type (for frontend preview — no computation).
 */
function getTemplatesForType(assignmentType) {
  return ASSIGNMENT_TASK_TEMPLATES[assignmentType] || [];
}

/**
 * List all supported assignment types.
 */
function getSupportedTypes() {
  return Object.keys(ASSIGNMENT_TASK_TEMPLATES);
}

// ─── PROJECT TYPE → ASSIGNMENT TYPE MAPPING ───────────────────────────────────
// NOTE: keys MUST match the `value` fields in the frontend's PROJECT_TYPES list
// (src/pages/admin/Projects.jsx). Previously these keys used old names
// (e.g. "website", "design", "marketing") that no longer match what the
// frontend actually sends (e.g. "website_development", "graphic_design",
// "email_marketing") — that mismatch meant "Generate Task Plan" silently
// produced almost nothing for most project types. Fixed below.
const PROJECT_TYPE_TO_ASSIGNMENT_TYPE = {
  website_development:   ['Design', 'Development', 'Testing'],
  mobile_app:             ['Design', 'Development', 'Testing'],
  role_based_dashboards:  ['Design', 'Development', 'Testing'],
  automation:             ['Development', 'Testing'],
  machine_learning:       ['Development', 'Testing'],
  graphic_design:         ['Design'],
  ui_ux_design:           ['Design'],
  branding:               ['Design'],
  seo:                    ['Marketing'],
  email_marketing:        ['Marketing'],
  google_ads:             ['Marketing'],
  other:                  ['Development', 'Testing'],
};

// ─── PHASE-BASED PARALLEL PLAN GENERATOR ─────────────────────────────────────
/**
 * Generate a unified, phase-based, GRANULAR project plan for multiple project
 * types. Development and design work is broken down into individual,
 * assignable units (one task per page / module / deliverable) rather than
 * one lumped "Development" task — this is what lets 2-3 people with the same
 * designation (e.g. 3 Full Stack Developers) actually split the work between
 * frontend / backend / feature areas instead of all landing on one person.
 *
 * PHASE STRUCTURE:
 *  Phase 1: Planning & Research      — kickoff, research, strategy (all parallel)
 *  Phase 2: Design & Strategy        — UI/UX, branding, content/marketing strategy
 *  Phase 3: Development & Build      — granular frontend/backend/feature tasks
 *  Phase 4: Testing & QA             — functional, performance, UAT prep
 *  Phase 5: Launch & Monitoring      — deployment, go-live, post-launch
 *
 * @param {string[]} projectTypes - e.g. ['website_development', 'seo']
 * @param {string}   description  - project description / requirements text (unused for now, kept for future NLP-based customization)
 * @returns {{ phases: PhaseObject[] }}
 */
function generateUnifiedProjectPlan(projectTypes = [], description = '') {
  if (!projectTypes || projectTypes.length === 0) {
    projectTypes = ['other'];
  }

  const has = (type) => projectTypes.includes(type);

  const hasWebsite    = has('website_development');
  const hasMobile     = has('mobile_app');
  const hasDashboard  = has('role_based_dashboards');
  const hasAutomation = has('automation');
  const hasML         = has('machine_learning');
  const hasGraphic    = has('graphic_design');
  const hasUIUX       = has('ui_ux_design');
  const hasBranding   = has('branding');
  const hasSEO        = has('seo');
  const hasEmail      = has('email_marketing');
  const hasGoogleAds  = has('google_ads');
  const hasOther      = has('other') || projectTypes.length === 0;

  // "Build" projects need a dev pipeline (frontend/backend/feature work + testing).
  const hasBuildProject = hasWebsite || hasMobile || hasDashboard || hasAutomation || hasML || hasOther;
  // "Design-only" projects (no code being written).
  const hasDesignOnly   = hasGraphic || hasUIUX || hasBranding;
  // Any marketing-flavoured work.
  const hasMarketingAny = hasSEO || hasEmail || hasGoogleAds;
  // UI/UX design work is needed both for design-only UI/UX projects AND as a
  // pre-step for anything with screens (website/mobile/dashboard).
  const needsUIUXWork   = hasUIUX || hasWebsite || hasMobile || hasDashboard;

  const phase1Tasks = [];
  const phase2Tasks = [];
  const phase3Tasks = [];
  const phase4Tasks = [];
  const phase5Tasks = [];

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: PLANNING & RESEARCH
  // ═══════════════════════════════════════════════════════════════════════
  phase1Tasks.push({
    title: "Project Kickoff & Scope Definition",
    role: "Project Manager",
    duration: "2 days",
    priority: "High",
    dependency: null,
    canRunParallel: false,
  });

  if (needsUIUXWork) {
    phase1Tasks.push({
      title: "UX Research & User Personas",
      role: "UI/UX Designer",
      duration: "2 days",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasWebsite) {
    phase1Tasks.push({
      title: "Sitemap & Content Inventory (Pages List)",
      role: "UI/UX Designer",
      duration: "1 day",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasBuildProject) {
    phase1Tasks.push({
      title: "Technical Architecture Planning",
      role: "Backend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasAutomation) {
    phase1Tasks.push({
      title: "Process Mapping & Requirements Gathering",
      role: "Automation Engineer",
      duration: "2 days",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasML) {
    phase1Tasks.push({
      title: "Data Requirements & Feasibility Study",
      role: "ML Engineer",
      duration: "2 days",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasBranding) {
    phase1Tasks.push({
      title: "Brand Discovery & Positioning Workshop",
      role: "Brand Strategist",
      duration: "2 days",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasSEO || hasGoogleAds) {
    phase1Tasks.push({
      title: "Keyword & Competitor Research",
      role: hasSEO ? "SEO Specialist" : "Google Ads Specialist",
      duration: "2 days",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  if (hasEmail) {
    phase1Tasks.push({
      title: "Audience Segmentation & List Strategy",
      role: "Email Marketing Specialist",
      duration: "1 day",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: DESIGN & STRATEGY
  // ═══════════════════════════════════════════════════════════════════════
  if (needsUIUXWork) {
    phase2Tasks.push({
      title: "Wireframing & User Flow Design",
      role: "UI/UX Designer",
      duration: "3 days",
      priority: "High",
      dependency: "UX Research & User Personas",
      canRunParallel: true,
    });
    phase2Tasks.push({
      title: "High-Fidelity UI Mockups (All Screens)",
      role: "UI/UX Designer",
      duration: "5 days",
      priority: "High",
      dependency: "Wireframing & User Flow Design",
      canRunParallel: false,
    });
    phase2Tasks.push({
      title: "Design System & Style Guide",
      role: "UI/UX Designer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Wireframing & User Flow Design",
      canRunParallel: true,
    });
    if (hasUIUX) {
      phase2Tasks.push({
        title: "Interactive Prototype",
        role: "UI/UX Designer",
        duration: "2 days",
        priority: "Medium",
        dependency: "High-Fidelity UI Mockups (All Screens)",
        canRunParallel: true,
      });
      phase2Tasks.push({
        title: "Usability Testing & Iteration",
        role: "UI/UX Designer",
        duration: "2 days",
        priority: "Medium",
        dependency: "Interactive Prototype",
        canRunParallel: false,
      });
      phase2Tasks.push({
        title: "Design Handoff (Specs, Assets, Style Guide)",
        role: "UI/UX Designer",
        duration: "1 day",
        priority: "Low",
        dependency: "Usability Testing & Iteration",
        canRunParallel: false,
      });
    }
  }

  if (hasGraphic) {
    phase2Tasks.push({
      title: "Design Brief & Moodboarding",
      role: "Graphic Designer",
      duration: "1 day",
      priority: "High",
      dependency: "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
    phase2Tasks.push({
      title: "Concept Design – Initial Drafts",
      role: "Graphic Designer",
      duration: "2 days",
      priority: "High",
      dependency: "Design Brief & Moodboarding",
      canRunParallel: false,
    });
    phase2Tasks.push({
      title: "Revisions & Refinement",
      role: "Graphic Designer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Concept Design – Initial Drafts",
      canRunParallel: false,
    });
    phase2Tasks.push({
      title: "Final Artwork & Export (All Formats)",
      role: "Graphic Designer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Revisions & Refinement",
      canRunParallel: false,
    });
  }

  if (hasBranding) {
    phase2Tasks.push({
      title: "Logo Concepts & Exploration",
      role: "Graphic Designer",
      duration: "3 days",
      priority: "High",
      dependency: "Brand Discovery & Positioning Workshop",
      canRunParallel: true,
    });
    phase2Tasks.push({
      title: "Logo Refinement & Finalization",
      role: "Graphic Designer",
      duration: "1 day",
      priority: "High",
      dependency: "Logo Concepts & Exploration",
      canRunParallel: false,
    });
    phase2Tasks.push({
      title: "Color Palette & Typography System",
      role: "Graphic Designer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Logo Refinement & Finalization",
      canRunParallel: true,
    });
    phase2Tasks.push({
      title: "Brand Guidelines Document",
      role: "Graphic Designer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Color Palette & Typography System",
      canRunParallel: false,
    });
    phase2Tasks.push({
      title: "Brand Collateral (Business Cards, Letterhead, Social Kit)",
      role: "Graphic Designer",
      duration: "2 days",
      priority: "Low",
      dependency: "Brand Guidelines Document",
      canRunParallel: true,
    });
  }

  if (hasMarketingAny) {
    phase2Tasks.push({
      title: "Content Strategy & Editorial Plan",
      role: "Content Writer",
      duration: "2 days",
      priority: "Medium",
      dependency: hasSEO ? "Keyword & Competitor Research" : "Project Kickoff & Scope Definition",
      canRunParallel: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3: DEVELOPMENT & BUILD  (granular — one task per page/module)
  // ═══════════════════════════════════════════════════════════════════════
  if (hasWebsite) {
    // ── Backend track ──
    phase3Tasks.push({
      title: "Server & Environment Setup",
      role: "Backend Developer",
      duration: "1 day",
      priority: "High",
      dependency: "Technical Architecture Planning",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Database Schema Design",
      role: "Backend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Server & Environment Setup",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Authentication & User Management API",
      role: "Backend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Database Schema Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Content / CMS API (Pages, Services, Blog)",
      role: "Backend Developer",
      duration: "3 days",
      priority: "High",
      dependency: "Database Schema Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Contact Form & Lead Capture API",
      role: "Backend Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Database Schema Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Admin Dashboard API Endpoints",
      role: "Backend Developer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Content / CMS API (Pages, Services, Blog)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Third-Party Integrations (Email, Payment, Analytics)",
      role: "Backend Developer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Contact Form & Lead Capture API",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "API Documentation & Backend Testing",
      role: "Backend Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Admin Dashboard API Endpoints",
      canRunParallel: true,
    });

    // ── Frontend track (one task per page, as requested) ──
    phase3Tasks.push({
      title: "Shared Navigation, Header & Footer",
      role: "Frontend Developer",
      duration: "1 day",
      priority: "High",
      dependency: "High-Fidelity UI Mockups (All Screens)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Homepage Development",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Shared Navigation, Header & Footer",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "About Us Page",
      role: "Frontend Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Shared Navigation, Header & Footer",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Services / Products Page(s)",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Shared Navigation, Header & Footer",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Portfolio / Case Studies Page",
      role: "Frontend Developer",
      duration: "1.5 days",
      priority: "Medium",
      dependency: "Shared Navigation, Header & Footer",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Blog / News Listing & Detail Pages",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Content / CMS API (Pages, Services, Blog)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Contact Us Page & Form Integration",
      role: "Frontend Developer",
      duration: "1 day",
      priority: "High",
      dependency: "Contact Form & Lead Capture API",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Frontend Routing & State Management",
      role: "Frontend Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Homepage Development",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Full API Integration (Connect All Pages to Backend)",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Authentication & User Management API",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Responsive Design & Cross-Browser Testing",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Full API Integration (Connect All Pages to Backend)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "SEO Meta Tags & Schema Setup",
      role: "Frontend Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Full API Integration (Connect All Pages to Backend)",
      canRunParallel: true,
    });
  }

  if (hasMobile) {
    phase3Tasks.push({
      title: "App Architecture & Navigation Setup",
      role: "Mobile Developer",
      duration: "1 day",
      priority: "High",
      dependency: "Technical Architecture Planning",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Backend API for Mobile App",
      role: "Backend Developer",
      duration: "3 days",
      priority: "High",
      dependency: "Technical Architecture Planning",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Onboarding & Authentication Screens",
      role: "Mobile Developer",
      duration: "2 days",
      priority: "High",
      dependency: "App Architecture & Navigation Setup",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Home / Dashboard Screen",
      role: "Mobile Developer",
      duration: "2 days",
      priority: "High",
      dependency: "App Architecture & Navigation Setup",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Core Feature Screens",
      role: "Mobile Developer",
      duration: "3 days",
      priority: "High",
      dependency: "Backend API for Mobile App",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Profile & Settings Screens",
      role: "Mobile Developer",
      duration: "1.5 days",
      priority: "Medium",
      dependency: "Onboarding & Authentication Screens",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Push Notifications Integration",
      role: "Mobile Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Backend API for Mobile App",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "App Store / Play Store Submission Prep",
      role: "Mobile Developer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Core Feature Screens",
      canRunParallel: false,
    });
  }

  if (hasDashboard) {
    phase3Tasks.push({
      title: "Role & Permission System Design",
      role: "Backend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Technical Architecture Planning",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Role-Based Access Control API",
      role: "Backend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Role & Permission System Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Admin Dashboard UI",
      role: "Frontend Developer",
      duration: "3 days",
      priority: "High",
      dependency: "Role & Permission System Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Manager Dashboard UI",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Role & Permission System Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Employee / User Dashboard UI",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Role & Permission System Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Dashboard Analytics & Reporting Widgets",
      role: "Frontend Developer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Role-Based Access Control API",
      canRunParallel: true,
    });
  }

  if (hasAutomation) {
    phase3Tasks.push({
      title: "Workflow Design & Trigger Mapping",
      role: "Automation Engineer",
      duration: "2 days",
      priority: "High",
      dependency: "Process Mapping & Requirements Gathering",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Automation Script / Bot Development",
      role: "Automation Engineer",
      duration: "4 days",
      priority: "High",
      dependency: "Workflow Design & Trigger Mapping",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Third-Party Tool Integrations (APIs / Webhooks)",
      role: "Automation Engineer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Workflow Design & Trigger Mapping",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Error Handling & Retry Logic",
      role: "Automation Engineer",
      duration: "1 day",
      priority: "Medium",
      dependency: "Automation Script / Bot Development",
      canRunParallel: true,
    });
  }

  if (hasML) {
    phase3Tasks.push({
      title: "Data Collection & Preprocessing",
      role: "ML Engineer",
      duration: "3 days",
      priority: "High",
      dependency: "Data Requirements & Feasibility Study",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Feature Engineering",
      role: "ML Engineer",
      duration: "2 days",
      priority: "High",
      dependency: "Data Collection & Preprocessing",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Model Selection & Training",
      role: "ML Engineer",
      duration: "4 days",
      priority: "High",
      dependency: "Feature Engineering",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Model Evaluation & Tuning",
      role: "ML Engineer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Model Selection & Training",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Model Deployment / API Wrapper",
      role: "Backend Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Model Evaluation & Tuning",
      canRunParallel: true,
    });
  }

  if (hasEmail) {
    phase3Tasks.push({
      title: "Email Template Design",
      role: "Graphic Designer",
      duration: "2 days",
      priority: "High",
      dependency: "Audience Segmentation & List Strategy",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Campaign Copywriting",
      role: "Content Writer",
      duration: "2 days",
      priority: "High",
      dependency: "Content Strategy & Editorial Plan",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Automation Workflow Setup (Welcome, Drip, Abandoned Cart)",
      role: "Email Marketing Specialist",
      duration: "2 days",
      priority: "High",
      dependency: "Email Template Design",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "A/B Testing Setup",
      role: "Email Marketing Specialist",
      duration: "1 day",
      priority: "Medium",
      dependency: "Automation Workflow Setup (Welcome, Drip, Abandoned Cart)",
      canRunParallel: true,
    });
  }

  if (hasSEO) {
    phase3Tasks.push({
      title: "Technical SEO Audit (Site Speed, Crawlability)",
      role: "SEO Specialist",
      duration: "2 days",
      priority: "High",
      dependency: "Keyword & Competitor Research",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "On-Page SEO Implementation (Meta, Headers, Content)",
      role: "SEO Specialist",
      duration: "3 days",
      priority: "High",
      dependency: "Technical SEO Audit (Site Speed, Crawlability)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Content Optimization & Internal Linking",
      role: "SEO Specialist",
      duration: "2 days",
      priority: "Medium",
      dependency: "On-Page SEO Implementation (Meta, Headers, Content)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Backlink Strategy & Outreach",
      role: "SEO Specialist",
      duration: "3 days",
      priority: "Medium",
      dependency: "On-Page SEO Implementation (Meta, Headers, Content)",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Local SEO & Google Business Profile",
      role: "SEO Specialist",
      duration: "1 day",
      priority: "Medium",
      dependency: "Technical SEO Audit (Site Speed, Crawlability)",
      canRunParallel: true,
    });
  }

  if (hasGoogleAds) {
    phase3Tasks.push({
      title: "Account Structure & Campaign Strategy",
      role: "Google Ads Specialist",
      duration: "1 day",
      priority: "High",
      dependency: "Keyword & Competitor Research",
      canRunParallel: false,
    });
    phase3Tasks.push({
      title: "Ad Copywriting & Extensions Setup",
      role: "Google Ads Specialist",
      duration: "2 days",
      priority: "High",
      dependency: "Account Structure & Campaign Strategy",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Landing Page Alignment Review",
      role: "Google Ads Specialist",
      duration: "1 day",
      priority: "Medium",
      dependency: "Account Structure & Campaign Strategy",
      canRunParallel: true,
    });
    phase3Tasks.push({
      title: "Conversion Tracking & Analytics Setup",
      role: "Google Ads Specialist",
      duration: "1 day",
      priority: "High",
      dependency: "Account Structure & Campaign Strategy",
      canRunParallel: true,
    });
  }

  if (hasOther && phase3Tasks.length === 0) {
    // True catch-all fallback — only used when nothing else matched.
    phase3Tasks.push({
      title: "Core Feature Development",
      role: "Full Stack Developer",
      duration: "5 days",
      priority: "High",
      dependency: "Technical Architecture Planning",
      canRunParallel: false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 4: TESTING & QA
  // ═══════════════════════════════════════════════════════════════════════
  if (hasBuildProject) {
    phase4Tasks.push({
      title: "Functional QA Testing (All Pages & Flows)",
      role: "QA Engineer",
      duration: "3 days",
      priority: "High",
      dependency: null,
      canRunParallel: true,
    });
    phase4Tasks.push({
      title: "Performance & Load Testing",
      role: "QA Engineer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Functional QA Testing (All Pages & Flows)",
      canRunParallel: false,
    });
    phase4Tasks.push({
      title: "Cross-Device & Accessibility Testing",
      role: "QA Engineer",
      duration: "2 days",
      priority: "Medium",
      dependency: "Functional QA Testing (All Pages & Flows)",
      canRunParallel: true,
    });
    phase4Tasks.push({
      title: "Bug Fixes & Regression Pass",
      role: "Full Stack Developer",
      duration: "2 days",
      priority: "High",
      dependency: "Performance & Load Testing",
      canRunParallel: false,
    });
  }

  if (hasEmail || hasGoogleAds) {
    phase4Tasks.push({
      title: "Campaign QA (Links, Tracking, Rendering)",
      role: hasEmail ? "Email Marketing Specialist" : "Google Ads Specialist",
      duration: "1 day",
      priority: "High",
      dependency: null,
      canRunParallel: true,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 5: LAUNCH & MONITORING
  // ═══════════════════════════════════════════════════════════════════════
  if (hasBuildProject) {
    phase5Tasks.push({
      title: "User Acceptance Testing (UAT)",
      role: "QA Engineer / Stakeholders",
      duration: "2 days",
      priority: "High",
      dependency: "Bug Fixes & Regression Pass",
      canRunParallel: false,
    });
    phase5Tasks.push({
      title: "Production Deployment & DevOps",
      role: "Backend Developer / DevOps",
      duration: "1 day",
      priority: "High",
      dependency: "User Acceptance Testing (UAT)",
      canRunParallel: false,
    });
    phase5Tasks.push({
      title: "Post-Launch Monitoring & Bug Fixes",
      role: "Full Stack Developer",
      duration: "5 days",
      priority: "High",
      dependency: "Production Deployment & DevOps",
      canRunParallel: true,
    });
  }

  if (hasAutomation) {
    phase5Tasks.push({
      title: "Monitoring & Alerting Setup",
      role: "Automation Engineer",
      duration: "1 day",
      priority: "Medium",
      dependency: null,
      canRunParallel: true,
    });
  }

  if (hasML) {
    phase5Tasks.push({
      title: "Model Monitoring & Retraining Plan",
      role: "ML Engineer",
      duration: "2 days",
      priority: "Medium",
      dependency: null,
      canRunParallel: true,
    });
  }

  if (hasMarketingAny) {
    phase5Tasks.push({
      title: "Go-Live Marketing Push & Announcements",
      role: hasSEO ? "SEO Specialist" : hasGoogleAds ? "Google Ads Specialist" : "Email Marketing Specialist",
      duration: "2 days",
      priority: "High",
      dependency: null,
      canRunParallel: true,
    });
    phase5Tasks.push({
      title: "Performance Reporting & Optimization",
      role: hasSEO ? "SEO Specialist" : hasGoogleAds ? "Google Ads Specialist" : "Email Marketing Specialist",
      duration: "3 days",
      priority: "Medium",
      dependency: "Go-Live Marketing Push & Announcements",
      canRunParallel: true,
    });
  }

  return {
    phases: [
      { name: "Phase 1: Planning & Research",  tasks: phase1Tasks },
      { name: "Phase 2: Design & Strategy",    tasks: phase2Tasks },
      { name: "Phase 3: Development & Build",  tasks: phase3Tasks },
      { name: "Phase 4: Testing & QA",         tasks: phase4Tasks },
      { name: "Phase 5: Launch & Monitoring",  tasks: phase5Tasks },
    ].filter(p => p.tasks.length > 0),
  };
}

function generatePlanForTypes(projectTypes = [], requirements = '') {
  const allTasks = [];
  const seenTitles = new Set();

  for (const pType of projectTypes) {
    const assignmentTypes = PROJECT_TYPE_TO_ASSIGNMENT_TYPE[pType] || ['Development'];
    for (const aType of assignmentTypes) {
      const templates = ASSIGNMENT_TASK_TEMPLATES[aType] || [];
      for (const t of templates) {
        if (!seenTitles.has(t.title)) {
          seenTitles.add(t.title);
          allTasks.push({ ...t, source_type: pType, phase: aType });
        }
      }
    }
  }

  const phases = {};
  for (const task of allTasks) {
    if (!phases[task.phase]) phases[task.phase] = [];
    phases[task.phase].push(task);
  }

  return { tasks: allTasks, phases };
}

module.exports = {
  generateTasksForAssignment,
  generateUnifiedProjectPlan,
  generatePlanForTypes,
  getTemplatesForType,
  getSupportedTypes,
  ASSIGNMENT_TASK_TEMPLATES,
  DEFAULT_DAILY_HOURS,
};