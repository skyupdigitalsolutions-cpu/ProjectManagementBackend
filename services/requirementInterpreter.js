/**
 * requirementInterpreter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts project description + project_type + complexity
 * into a structured list of modules, each containing task drafts.
 *
 * Used by:
 *   - autoplanPreview  → shows admin what will be created (before saving)
 *   - createProjectWizard (auto_plan mode) → generates and saves everything
 */

// ─── Module templates per project type ──────────────────────────────────────
// Each task has: title, required_role, required_department, estimated_days, priority
// complexity filter: "small" uses only core tasks, "medium" adds standard, "large" adds all

const MODULE_TEMPLATES = {

  website: [
    {
      name: "UI/UX Design",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Wireframes & site structure",    required_role: "designer",           required_department: "Design",          estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "High-fidelity design mockups",   required_role: "designer",           required_department: "Design",          estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Brand identity & style guide",   required_role: "designer",           required_department: "Design",          estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "Frontend Development",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Homepage layout & components",   required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Navigation & routing setup",     required_role: "frontend developer", required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["small","medium","large"] },
        { title: "Responsive design implementation",required_role: "frontend developer",required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
        { title: "Inner pages UI development",     required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "medium", complexity: ["medium","large"] },
        { title: "Animations & micro-interactions",required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "low",    complexity: ["large"] },
      ],
    },
    {
      name: "Backend Development",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Project setup & server config",  required_role: "backend developer",  required_department: "Web Development", estimated_days: 1, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Database schema design",         required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
        { title: "REST API development",           required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Contact form & email API",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["small","medium","large"] },
      ],
    },
    {
      name: "SEO & Launch",
      complexity: ["medium", "large"],
      tasks: [
        { title: "On-page SEO setup",              required_role: "seo specialist",     required_department: "SEO",             estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Performance & speed optimization",required_role: "frontend developer",required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
        { title: "Cross-browser testing & QA",    required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["large"] },
      ],
    },
  ],

  ecommerce: [
    {
      name: "Authentication",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Login & signup UI",              required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Auth API & JWT handling",        required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Password reset flow",            required_role: "backend developer",  required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
        { title: "Social login integration",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "low",    complexity: ["large"] },
      ],
    },
    {
      name: "Product Management",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Product listing page UI",        required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Product detail page UI",         required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Product CRUD API",               required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Product filters & search",       required_role: "full stack developer",required_department: "Web Development",estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Product image upload & CDN",     required_role: "backend developer",  required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
        { title: "Inventory management system",    required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["large"] },
      ],
    },
    {
      name: "Cart & Checkout",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Shopping cart UI",               required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Cart management API",            required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Checkout flow UI",               required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Address & shipping module",      required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
      ],
    },
    {
      name: "Payment System",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Payment gateway integration",    required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "critical",complexity: ["small","medium","large"] },
        { title: "Order confirmation & invoices",  required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Refund & return API",            required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Multi-currency support",         required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "low",    complexity: ["large"] },
      ],
    },
    {
      name: "Admin Dashboard",
      complexity: ["medium", "large"],
      tasks: [
        { title: "Admin panel UI",                 required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Sales analytics & charts",       required_role: "full stack developer",required_department: "Web Development",estimated_days: 3, priority: "medium", complexity: ["medium","large"] },
        { title: "User management module",         required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "SEO & Marketing",
      complexity: ["medium", "large"],
      tasks: [
        { title: "On-page SEO optimization",       required_role: "seo specialist",     required_department: "SEO",             estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Product schema markup",          required_role: "seo specialist",     required_department: "SEO",             estimated_days: 1, priority: "medium", complexity: ["large"] },
      ],
    },
  ],

  mobile_app: [
    {
      name: "UI/UX Design",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "App wireframes & user flow",     required_role: "designer",           required_department: "Design",          estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "High-fidelity screen designs",   required_role: "designer",           required_department: "Design",          estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Design system & component kit",  required_role: "designer",           required_department: "Design",          estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "Authentication",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Login & signup screens",         required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Auth API & token management",    required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Biometric / social login",       required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "Core Features",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Home screen & navigation",       required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Core feature screens",           required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 5, priority: "high",   complexity: ["small","medium","large"] },
        { title: "REST API integration",           required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Push notifications",             required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Offline mode & caching",         required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 2, priority: "low",    complexity: ["large"] },
      ],
    },
    {
      name: "Testing & Release",
      complexity: ["medium", "large"],
      tasks: [
        { title: "Device compatibility testing",   required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
        { title: "App store submission setup",     required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
        { title: "Performance & crash testing",    required_role: "mobile developer",   required_department: "Mobile",          estimated_days: 2, priority: "high",   complexity: ["large"] },
      ],
    },
  ],

  api_service: [
    {
      name: "Project Setup",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Server & environment setup",     required_role: "backend developer",  required_department: "Web Development", estimated_days: 1, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Database design & schema",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
      ],
    },
    {
      name: "API Development",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Core CRUD endpoints",            required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Authentication & authorization", required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Input validation & error handling",required_role: "backend developer",required_department: "Web Development", estimated_days: 1, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Rate limiting & security",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
        { title: "API documentation (Swagger)",    required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Webhooks & event system",        required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "Testing & Deployment",
      complexity: ["medium", "large"],
      tasks: [
        { title: "Unit & integration testing",     required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
        { title: "CI/CD pipeline setup",           required_role: "full stack developer",required_department: "Web Development",estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
  ],

  data_analytics: [
    {
      name: "Data Pipeline",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Data source integration",        required_role: "data analyst",       required_department: "Analytics",       estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "ETL pipeline setup",             required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Data cleaning & transformation", required_role: "data analyst",       required_department: "Analytics",       estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
      ],
    },
    {
      name: "Analytics & Reporting",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "KPI metrics definition",         required_role: "data analyst",       required_department: "Analytics",       estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Dashboard design",               required_role: "designer",           required_department: "Design",          estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Charts & visualizations",        required_role: "data analyst",       required_department: "Analytics",       estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Automated reporting system",     required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "medium", complexity: ["large"] },
      ],
    },
  ],

  design: [
    {
      name: "Brand Design",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Brand discovery & mood board",   required_role: "designer",           required_department: "Design",          estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Logo design concepts",           required_role: "designer",           required_department: "Design",          estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Color palette & typography",     required_role: "designer",           required_department: "Design",          estimated_days: 1, priority: "medium", complexity: ["small","medium","large"] },
        { title: "Brand style guide document",     required_role: "designer",           required_department: "Design",          estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Marketing collateral designs",   required_role: "designer",           required_department: "Design",          estimated_days: 3, priority: "medium", complexity: ["large"] },
      ],
    },
  ],

  content: [
    {
      name: "Content Strategy",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Content audit & strategy doc",   required_role: "content writer",     required_department: "Content Writing", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Keyword research & mapping",     required_role: "content writer",     required_department: "Content Writing", estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
      ],
    },
    {
      name: "Content Production",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Homepage & core page copy",      required_role: "content writer",     required_department: "Content Writing", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Blog articles (batch 1)",        required_role: "content writer",     required_department: "Content Writing", estimated_days: 3, priority: "medium", complexity: ["medium","large"] },
        { title: "Blog articles (batch 2)",        required_role: "content writer",     required_department: "Content Writing", estimated_days: 3, priority: "medium", complexity: ["large"] },
        { title: "Social media content calendar", required_role: "content writer",     required_department: "Content Writing", estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
      ],
    },
  ],

  seo: [
    {
      name: "SEO Audit & Strategy",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Technical SEO audit",            required_role: "seo specialist",     required_department: "SEO",             estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Competitor & keyword research",  required_role: "seo specialist",     required_department: "SEO",             estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "SEO strategy document",          required_role: "seo specialist",     required_department: "SEO",             estimated_days: 1, priority: "high",   complexity: ["medium","large"] },
      ],
    },
    {
      name: "On-Page SEO",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Meta titles & descriptions",     required_role: "seo specialist",     required_department: "SEO",             estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Content optimization",           required_role: "content writer",     required_department: "Content Writing", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Schema markup implementation",  required_role: "seo specialist",     required_department: "SEO",             estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
        { title: "Internal linking strategy",      required_role: "seo specialist",     required_department: "SEO",             estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "Off-Page & Reporting",
      complexity: ["medium", "large"],
      tasks: [
        { title: "Link building outreach",         required_role: "seo specialist",     required_department: "SEO",             estimated_days: 3, priority: "medium", complexity: ["medium","large"] },
        { title: "Monthly SEO report setup",      required_role: "seo specialist",     required_department: "SEO",             estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
      ],
    },
  ],

  marketing: [
    {
      name: "Strategy & Planning",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Marketing strategy document",    required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Audience research & personas",   required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
      ],
    },
    {
      name: "Campaign Execution",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Social media content plan",      required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Ad creatives & copy",            required_role: "content writer",     required_department: "Content Writing", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Email marketing campaign",       required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
        { title: "Paid ads setup & targeting",     required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
        { title: "Influencer outreach campaign",   required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 3, priority: "medium", complexity: ["large"] },
      ],
    },
    {
      name: "Analytics & Reporting",
      complexity: ["medium", "large"],
      tasks: [
        { title: "Campaign performance tracking",  required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 1, priority: "medium", complexity: ["medium","large"] },
        { title: "ROI & conversion reporting",     required_role: "marketing specialist",required_department: "Social Media",   estimated_days: 2, priority: "medium", complexity: ["large"] },
      ],
    },
  ],

  other: [
    {
      name: "Planning & Setup",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Project requirements gathering", required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
        { title: "Technical architecture design",  required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["medium","large"] },
      ],
    },
    {
      name: "Core Development",
      complexity: ["small", "medium", "large"],
      tasks: [
        { title: "Core feature development",       required_role: "full stack developer",required_department: "Web Development",estimated_days: 5, priority: "high",   complexity: ["small","medium","large"] },
        { title: "UI implementation",              required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["medium","large"] },
        { title: "Testing & QA",                   required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["medium","large"] },
      ],
    },
  ],
};

// ─── Keyword → extra module names to inject ──────────────────────────────────
// If these words appear in the description, add these extra modules
const KEYWORD_MODULES = {
  "payment":       { name: "Payment Integration",    tasks: [
    { title: "Payment gateway setup",     required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "critical", complexity: ["small","medium","large"] },
    { title: "Checkout UI",              required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",     complexity: ["small","medium","large"] },
  ]},
  "chat":          { name: "Chat / Messaging",       tasks: [
    { title: "Real-time chat UI",        required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
    { title: "WebSocket chat API",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
  ]},
  "notification":  { name: "Notification System",    tasks: [
    { title: "In-app notification UI",   required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
    { title: "Push notification API",    required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
  ]},
  "search":        { name: "Search & Filter",        tasks: [
    { title: "Search bar UI",            required_role: "frontend developer", required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["small","medium","large"] },
    { title: "Search & filter API",      required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
  ]},
  "analytics":     { name: "Analytics Dashboard",    tasks: [
    { title: "Analytics charts UI",      required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "medium", complexity: ["small","medium","large"] },
    { title: "Analytics data API",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
  ]},
  "upload":        { name: "File Upload System",     tasks: [
    { title: "File upload UI component", required_role: "frontend developer", required_department: "Web Development", estimated_days: 1, priority: "medium", complexity: ["small","medium","large"] },
    { title: "File storage & CDN API",   required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
  ]},
  "blog":          { name: "Blog / CMS",             tasks: [
    { title: "Blog listing & detail pages",required_role: "frontend developer",required_department: "Web Development",estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
    { title: "Blog content API",         required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
    { title: "Blog articles writing",    required_role: "content writer",     required_department: "Content Writing", estimated_days: 3, priority: "medium", complexity: ["medium","large"] },
  ]},
  "map":           { name: "Maps & Location",        tasks: [
    { title: "Maps integration UI",      required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
    { title: "Location API & geocoding", required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
  ]},
  "subscription":  { name: "Subscription & Billing", tasks: [
    { title: "Pricing page UI",          required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
    { title: "Subscription billing API", required_role: "backend developer",  required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
  ]},
  "admin":         { name: "Admin Panel",             tasks: [
    { title: "Admin dashboard UI",       required_role: "frontend developer", required_department: "Web Development", estimated_days: 3, priority: "high",   complexity: ["small","medium","large"] },
    { title: "Admin CRUD APIs",          required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "high",   complexity: ["small","medium","large"] },
  ]},
  "report":        { name: "Reports & Export",        tasks: [
    { title: "Report UI & filters",      required_role: "frontend developer", required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
    { title: "PDF/CSV export API",       required_role: "backend developer",  required_department: "Web Development", estimated_days: 2, priority: "medium", complexity: ["small","medium","large"] },
  ]},
};

/**
 * Main interpreter function.
 *
 * @param {string} description   - Project description written by admin
 * @param {string} project_type  - One of the enum values from Project model
 * @param {string} complexity    - "small" | "medium" | "large"
 * @returns {Array}  Array of module objects: { name, tasks[] }
 *                   Each task has all fields needed for scheduling + assignment
 */
function interpretRequirements(description, project_type, complexity = "medium") {
  const type   = project_type || "other";
  const level  = complexity   || "medium";
  const lower  = (description || "").toLowerCase();

  // 1. Get base modules for this project type, filtered by complexity
  const baseTemplates = MODULE_TEMPLATES[type] || MODULE_TEMPLATES.other;

  const modules = baseTemplates
    .filter(mod => mod.complexity.includes(level))
    .map(mod => ({
      name:  mod.name,
      tasks: mod.tasks
        .filter(t => t.complexity.includes(level))
        .map(({ complexity: _c, ...t }) => ({ ...t })), // strip complexity key from output
    }))
    .filter(mod => mod.tasks.length > 0);

  // 2. Scan description for keywords → inject extra modules if not already present
  const existingModuleNames = new Set(modules.map(m => m.name));

  for (const [keyword, extraMod] of Object.entries(KEYWORD_MODULES)) {
    if (lower.includes(keyword) && !existingModuleNames.has(extraMod.name)) {
      modules.push({
        name:  extraMod.name,
        tasks: extraMod.tasks
          .filter(t => t.complexity.includes(level))
          .map(({ complexity: _c, ...t }) => ({ ...t })),
      });
      existingModuleNames.add(extraMod.name);
    }
  }

  return modules;
}

/**
 * Flatten modules into a plain task-draft array (for use by autoAssignProjectTasks).
 *
 * @param {Array}  modules    - Output of interpretRequirements()
 * @returns {Array} Flat array of task drafts with module_name attached
 */
function flattenModulesToDrafts(modules) {
  return modules.flatMap(mod =>
    mod.tasks.map(task => ({ ...task, module_name: mod.name }))
  );
}

module.exports = { interpretRequirements, flattenModulesToDrafts, MODULE_TEMPLATES, KEYWORD_MODULES };
