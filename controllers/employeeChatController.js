/**
 * controllers/employeeChatController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Employee-only group chat. Every handler double-checks role === 'employee'
 * (defence in depth on top of the route guard) so admins/managers can never
 * read or post — no endpoint here returns messages to a non-employee.
 */

const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/users');

const CHANNEL = 'employees';
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const handleError = (res, error, code = 500) => {
  console.error('[employeeChat]', error);
  return res.status(code).json({ success: false, message: error.message || 'Internal server error' });
};

// Hard gate — even if a route were mis-wired, non-employees get nothing.
function ensureEmployee(req, res) {
  if (req.user?.role !== 'employee') {
    res.status(403).json({ success: false, message: 'This chat is available to employees only.' });
    return false;
  }
  return true;
}

// ─── GET MESSAGES ─────────────────────────────────────────────────────────────
// GET /employee-chat/messages?limit=50            → latest N (chronological)
// GET /employee-chat/messages?before=<ISO>&limit  → older history page
// GET /employee-chat/messages?after=<ISO>         → new messages since (polling)
const getMessages = async (req, res) => {
  if (!ensureEmployee(req, res)) return;
  try {
    const { limit = 50, before, after } = req.query;
    const q = { channel: CHANNEL, deleted: false };

    let docs;
    if (after) {
      const d = new Date(after);
      if (isNaN(d)) return res.status(400).json({ success: false, message: 'Invalid "after" date' });
      q.createdAt = { $gt: d };
      docs = await Message.find(q).sort({ createdAt: 1 }).limit(200).populate('sender_id', 'name');
    } else {
      if (before) {
        const d = new Date(before);
        if (isNaN(d)) return res.status(400).json({ success: false, message: 'Invalid "before" date' });
        q.createdAt = { $lt: d };
      }
      const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
      docs = await Message.find(q).sort({ createdAt: -1 }).limit(n).populate('sender_id', 'name');
      docs = docs.reverse(); // return chronological (oldest → newest)
    }

    return res.status(200).json({ success: true, data: docs });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
// POST /employee-chat/messages  { content }
const sendMessage = async (req, res) => {
  if (!ensureEmployee(req, res)) return;
  try {
    const { content } = req.body || {};
    if (!content || !content.trim())
      return res.status(400).json({ success: false, message: 'Message cannot be empty' });
    if (content.length > 4000)
      return res.status(400).json({ success: false, message: 'Message is too long (max 4000 characters)' });

    const msg = await Message.create({
      channel: CHANNEL,
      sender_id: req.user._id,
      content: content.trim(),
    });
    await msg.populate('sender_id', 'name');

    return res.status(201).json({ success: true, data: msg });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── DELETE OWN MESSAGE ───────────────────────────────────────────────────────
// DELETE /employee-chat/messages/:id  (sender only, soft delete)
const deleteMessage = async (req, res) => {
  if (!ensureEmployee(req, res)) return;
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ success: false, message: 'Invalid message ID' });

    const msg = await Message.findOne({ _id: id, channel: CHANNEL });
    if (!msg || msg.deleted)
      return res.status(404).json({ success: false, message: 'Message not found' });
    if (msg.sender_id.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'You can only delete your own messages' });

    // Soft delete. Use updateOne (not .save) so the `content: required` rule
    // doesn't reject the cleared content. getMessages filters out deleted docs.
    await Message.updateOne({ _id: id }, { $set: { deleted: true, content: '' } });

    return res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── PARTICIPANTS ─────────────────────────────────────────────────────────────
// GET /employee-chat/participants  → active employees (for the roster)
const getParticipants = async (req, res) => {
  if (!ensureEmployee(req, res)) return;
  try {
    const users = await User.find({ role: 'employee', status: { $ne: 'inactive' } })
      .select('name')
      .sort({ name: 1 })
      .lean();
    return res.status(200).json({ success: true, data: users });
  } catch (error) {
    return handleError(res, error);
  }
};

module.exports = { getMessages, sendMessage, deleteMessage, getParticipants };