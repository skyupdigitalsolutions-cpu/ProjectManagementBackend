/**
 * routes/employeeChatRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Employee-only chat. `authorise('employee')` blocks admin AND manager at the
 * route layer; the controller re-checks as well.
 */

const express = require('express');
const router = express.Router();

const {
  getMessages,
  sendMessage,
  deleteMessage,
  getParticipants,
} = require('../controllers/employeeChatController');
const { protect, authorise } = require('../middleware/authMiddleware');

router.use(protect, authorise('employee'));

router.get('/messages', getMessages);
router.post('/messages', sendMessage);
router.delete('/messages/:id', deleteMessage);
router.get('/participants', getParticipants);

module.exports = router;