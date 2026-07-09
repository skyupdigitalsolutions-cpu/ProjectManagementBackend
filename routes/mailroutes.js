// routes/mailroutes.js  (CommonJS)
//
// Paths below match your structure:
//   models/users.js, middleware/authMiddleware.js, utils/crypto.js, services/mailservice.js
// This file goes in  routes/  and is registered in routes/Index.js (see instructions).

const express = require('express');
const User = require('../models/users');
const { protect } = require('../middleware/authMiddleware');
const { encrypt, decrypt } = require('../utils/crypto');
const {
  verifyMailbox, listMessages, getMessage, sendMessage,
} = require('../services/mailservice');

const router = express.Router();

async function credsFor(userId) {
  const user = await User.findById(userId).select('+mail_config.password_enc');
  if (!user || !user.mail_config || !user.mail_config.email || !user.mail_config.password_enc) return null;
  return { email: user.mail_config.email, password: decrypt(user.mail_config.password_enc) };
}

// Connect / update mailbox credentials (verifies before saving)
router.post('/connect', protect, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
  try {
    await verifyMailbox({ email, password });
  } catch {
    return res.status(401).json({ message: 'Could not sign in to that mailbox. Check the email and password.' });
  }
  await User.findByIdAndUpdate(req.user._id, {
    mail_config: { email, password_enc: encrypt(password) },
  });
  res.json({ connected: true, email });
});

// Is a mailbox connected? (never returns the password)
router.get('/status', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  res.json({ connected: !!creds, email: creds ? creds.email : null });
});

// Disconnect
router.delete('/disconnect', protect, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { $unset: { mail_config: 1 } });
  res.json({ connected: false });
});

// List messages
router.get('/messages', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await listMessages(creds, req.query.box || 'INBOX', Number(req.query.limit) || 40);
    res.json({ data });
  } catch (e) {
    res.status(502).json({ message: 'Failed to fetch mail', error: e.message });
  }
});

// Read one message (marks as seen)
router.get('/messages/:uid', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await getMessage(creds, Number(req.params.uid), req.query.box || 'INBOX');
    res.json({ data });
  } catch (e) {
    res.status(502).json({ message: 'Failed to open message', error: e.message });
  }
});

// Send / reply / forward
router.post('/send', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await sendMessage(creds, req.body || {});
    res.json({ data });
  } catch (e) {
    res.status(502).json({ message: 'Failed to send message', error: e.message });
  }
});

module.exports = router;