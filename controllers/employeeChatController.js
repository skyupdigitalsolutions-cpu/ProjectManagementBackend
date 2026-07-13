/**
 * controllers/employeeChatController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Employee-only group chat. Every handler double-checks role === 'employee'
 * (defence in depth on top of the route guard) so admins/managers can never
 * read or post — no endpoint here returns messages to a non-employee.
 *
 * Messages support:
 *   - text content
 *   - @-mentions of other employees (validated server-side; non-employees
 *     silently dropped so admins/managers can't be mentioned)
 *   - file / image / video attachments, uploaded to Cloudinary
 */

const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/users');
const Notification = require('../models/notification');
const { cloudinary } = require('../config/cloudinary');

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

// Upload one in-memory file (multer memoryStorage) to Cloudinary. resource_type
// "auto" lets Cloudinary accept images, videos AND raw files (pdf/doc/zip…) and
// tells us back which it was, so the client can render it correctly.
const uploadChatFile = (file) =>
  new Promise((resolve, reject) => {
    if (!file || !file.buffer) return reject(new Error('No file buffer provided'));
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'employee-chat', resource_type: 'auto', use_filename: true, unique_filename: true },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          url:           result.secure_url,
          name:          file.originalname,
          type:          file.mimetype,
          resource_type: result.resource_type || 'raw',
          bytes:         result.bytes || file.size || 0,
          width:         result.width,
          height:        result.height,
        });
      }
    );
    stream.end(file.buffer);
  });

// Accept mentions as a JSON array string (multipart), a comma list, or an array.
function parseMentions(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = raw.split(',').map((s) => s.trim()); }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.filter((id) => isValidObjectId(id)).map(String);
}

// Best-effort in-app notification to each mentioned employee (never the sender).
async function notifyMentions(sender, mentionedUsers) {
  const recipients = (mentionedUsers || []).filter(
    (u) => u._id.toString() !== sender._id.toString()
  );
  if (!recipients.length) return;
  const docs = recipients.map((u) => ({
    user_id:   u._id,
    sender_id: sender._id,
    message:   `${sender.name || 'Someone'} mentioned you in Team Chat`,
    type:      'general',
    ref_type:  'User',
    ref_id:    sender._id,
  }));
  await Notification.insertMany(docs);
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
      docs = await Message.find(q).sort({ createdAt: 1 }).limit(200)
        .populate('sender_id', 'name').populate('mentions', 'name');
    } else {
      if (before) {
        const d = new Date(before);
        if (isNaN(d)) return res.status(400).json({ success: false, message: 'Invalid "before" date' });
        q.createdAt = { $lt: d };
      }
      const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
      docs = await Message.find(q).sort({ createdAt: -1 }).limit(n)
        .populate('sender_id', 'name').populate('mentions', 'name');
      docs = docs.reverse(); // return chronological (oldest → newest)
    }

    return res.status(200).json({ success: true, data: docs });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
// POST /employee-chat/messages  (multipart or JSON)
//   content   {string}   optional if attachments present
//   mentions  {string}   JSON array of employee IDs (optional)
//   attachments[] {file} up to 5 files (optional)
const sendMessage = async (req, res) => {
  if (!ensureEmployee(req, res)) return;
  try {
    const content = (req.body?.content || '').trim();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!content && files.length === 0)
      return res.status(400).json({ success: false, message: 'Message cannot be empty' });
    if (content.length > 4000)
      return res.status(400).json({ success: false, message: 'Message is too long (max 4000 characters)' });

    // Validate mentions → keep only real employees.
    let mentionIds = parseMentions(req.body?.mentions);
    let mentionedUsers = [];
    if (mentionIds.length) {
      mentionedUsers = await User.find({ _id: { $in: mentionIds }, role: 'employee' })
        .select('_id name').lean();
      mentionIds = mentionedUsers.map((u) => u._id);
    }

    // Upload any attachments to Cloudinary.
    let attachments = [];
    if (files.length) attachments = await Promise.all(files.map(uploadChatFile));

    const msg = await Message.create({
      channel:     CHANNEL,
      sender_id:   req.user._id,
      content,
      attachments,
      mentions:    mentionIds,
    });
    await msg.populate('sender_id', 'name');
    await msg.populate('mentions', 'name');

    // Non-blocking: notify mentioned employees via the in-app bell.
    notifyMentions(req.user, mentionedUsers).catch((e) =>
      console.error('[employeeChat] mention notify failed', e.message)
    );

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

    // Soft delete. Also clears content/attachments/mentions so nothing lingers.
    await Message.updateOne(
      { _id: id },
      { $set: { deleted: true, content: '', attachments: [], mentions: [] } }
    );

    return res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    return handleError(res, error);
  }
};

// ─── PARTICIPANTS ─────────────────────────────────────────────────────────────
// GET /employee-chat/participants  → active employees (for the roster + @mention)
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