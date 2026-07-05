require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/users');
const URI = process.env.MONGODB_SEED_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/project-management';
(async () => {
  await mongoose.connect(URI);
  const users = await User.find({}).select('name role status designation department');
  console.log(`Total users: ${users.length}\n`);
  users.forEach(u => console.log(
    `name="${u.name}" | role=${u.role} | status=${u.status} | designation="${u.designation}"`
  ));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });