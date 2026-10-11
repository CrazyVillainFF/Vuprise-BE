const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { upload, validateImageContent } = require('../middleware/uploadMiddleware');
const {
  getContacts,
  getOwnKey,
  saveOwnKey,
  getOwnKeyBackups,
  saveOwnKeyBackup,
  listConversations,
  openConversation,
  deleteConversationForUser,
  updateConversationName,
  deleteMessage,
  updateMessage,
  getMessages,
  sendMessage,
  syncLegacyMessages
} = require('../controllers/messageController');
const { requireConversationParticipant } = require('../controllers/messageController');

const router = express.Router();
router.use(protect);
router.get('/contacts', getContacts);
router.get('/keys/me', getOwnKey);
router.put('/keys/me', saveOwnKey);
router.get('/keys/backups', getOwnKeyBackups);
router.post('/keys/backups', saveOwnKeyBackup);
router.get('/conversations', listConversations);
router.post('/conversations/:userId', openConversation);
router.delete('/conversations/:conversationId', deleteConversationForUser);
router.patch('/conversations/:conversationId', updateConversationName);
router.get('/conversations/:conversationId/messages', getMessages);
router.delete('/conversations/:conversationId/messages/:messageId', deleteMessage);
router.put('/conversations/:conversationId/messages/:messageId', updateMessage);
router.post('/conversations/:conversationId/messages', requireConversationParticipant, upload.single('image'), validateImageContent, sendMessage);
router.post('/conversations/:conversationId/messages/sync-legacy', syncLegacyMessages);

module.exports = router;
