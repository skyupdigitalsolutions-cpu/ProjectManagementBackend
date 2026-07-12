// routes/mailroutes.js  (CommonJS)
// Registered in routes/Index.js as router.use("/mail", mailRoutes) -> /api/mail/*

const express = require('express');
const User = require('../models/users');
const { protect } = require('../middleware/authMiddleware');
const { encrypt, decrypt } = require('../utils/crypto');
const {
  verifyMailbox, listFolders, listMessages, getMessage,
  deleteMessage, getContacts, sendMessage,
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
  } catch (e) {
    console.error('[mail] connect failed:', e.code, e.message);
    // NOTE: use 400 (not 401) here. A 401 means "your APP session expired" and
    // the frontend's global axios interceptor logs the user out on any 401. This
    // failure is a MAILBOX credential problem, not an app-auth problem, so it
    // must not trigger that logout. 400 lets the Mail page show the real error.
    return res.status(400).json({ message: 'Could not sign in to that mailbox. Check the email and password.' });
  }
  await User.findByIdAndUpdate(req.user._id, {
    mail_config: { email, password_enc: encrypt(password) },
  });
  res.json({ connected: true, email });
});

// Status
router.get('/status', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  res.json({ connected: !!creds, email: creds ? creds.email : null });
});

// Disconnect
router.delete('/disconnect', protect, async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { $unset: { mail_config: 1 } });
  res.json({ connected: false });
});

// Folders
router.get('/folders', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await listFolders(creds);
    res.json({ data });
  } catch (e) {
    console.error('[mail] folders failed:', e.code, e.message);
    res.status(502).json({ message: 'Failed to load folders', error: e.message });
  }
});

// Contacts (derived from mail participants)
router.get('/contacts', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await getContacts(creds);
    res.json({ data });
  } catch (e) {
    console.error('[mail] contacts failed:', e.code, e.message);
    res.status(502).json({ message: 'Failed to load contacts', error: e.message });
  }
});

// List / search messages   ?box=INBOX&limit=40&search=term
router.get('/messages', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await listMessages(creds, {
      box: req.query.box || 'INBOX',
      limit: Number(req.query.limit) || 40,
      search: req.query.search || '',
    });
    res.json({ data });
  } catch (e) {
    console.error('[mail] list failed:', e.code, e.message);
    res.status(502).json({ message: 'Failed to fetch mail', error: e.message });
  }
});

// Read one message
router.get('/messages/:uid', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await getMessage(creds, Number(req.params.uid), req.query.box || 'INBOX');
    res.json({ data });
  } catch (e) {
    console.error('[mail] read failed:', e.code, e.message);
    res.status(502).json({ message: 'Failed to open message', error: e.message });
  }
});

// Delete (move to Trash if available)
router.delete('/messages/:uid', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    await deleteMessage(creds, Number(req.params.uid), req.query.box || 'INBOX');
    res.json({ deleted: true });
  } catch (e) {
    console.error('[mail] delete failed:', e.code, e.message);
    res.status(502).json({ message: 'Failed to delete message', error: e.message });
  }
});

// Send / reply / forward
router.post('/send', protect, async (req, res) => {
  const creds = await credsFor(req.user._id);
  if (!creds) return res.status(400).json({ message: 'Mailbox not connected' });
  try {
    const data = await sendMessage(creds, { ...(req.body || {}), fromName: req.user.name });
    res.json({ data });
  } catch (e) {
    // Full detail in Render logs so SMTP failures are diagnosable
    console.error('[mail] send failed:', e.code, e.message);
    res.status(502).json({ message: 'Failed to send message', code: e.code || null, error: e.message });
  }
});

module.exports = router;