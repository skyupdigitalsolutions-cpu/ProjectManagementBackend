require('dotenv').config();
const mongoose = require('mongoose');
const TaskTemplate = require('../models/TaskTemplate');
const URI = process.env.MONGODB_SEED_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/project-management';
(async () => {
  await mongoose.connect(URI);
  const t = await TaskTemplate.findOne({ projectType: 'website_development' }).lean();
  if (!t) { console.log('No website_development template found.'); process.exit(0); }
  console.log(`Template: "${t.name}" | tasks: ${t.tasks.length}\n`);
  t.tasks.slice(0, 6).forEach((task, i) => {
    console.log(`${i+1}. ${task.name}`);
    console.log(`     designation="${task.designation}"  assignedTo=${task.assignedTo || 'NULL'}`);
  });
  console.log('\n(showing first 6 — if assignedTo=NULL everywhere, the field is not persisted)');
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });