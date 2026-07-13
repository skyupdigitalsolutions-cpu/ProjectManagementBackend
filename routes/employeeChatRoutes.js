/**
 * routes/employeeChatRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Employee-only chat. `authorise('employee')` blocks admin AND manager at the
 * route layer; the controller re-checks as well.
 *
 * POST /messages accepts multipart/form-data so employees can attach images,
 * videos and files. Uses multer memoryStorage (the buffer is streamed straight
 * to Cloudinary in the controller — nothing is written to local disk).
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();

const {
  getMessages,
  sendMessage,
  deleteMessage,
  getParticipants,
} = require('../controllers/employeeChatController');
const { protect, authorise } = require('../middleware/authMiddleware');

router.use(protect, authorise('employee'));

// In-memory upload for chat attachments. 25 MB/file keeps short clips workable
// while staying within typical Cloudinary limits. Bump if you need longer video.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 5 },
});

// Wrap multer so a rejected/too-large file returns a clean JSON 400
// instead of falling through to the generic Express error handler.
const withAttachments = (req, res, next) =>
  upload.array('attachments', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
    next();
  });

router.get('/messages', getMessages);
router.post('/messages', withAttachments, sendMessage);
router.delete('/messages/:id', deleteMessage);
router.get('/participants', getParticipants);

module.exports = router;