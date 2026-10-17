const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { aiAttachmentUpload, validateAiImageContent } = require('../middleware/uploadMiddleware');
const {
  listConversations,
  createConversation,
  getConversation,
  sendConversationMessage,
  uploadAttachments,
  deleteConversation,
  getAiStatus
} = require('../controllers/aiController');

const router = express.Router();

// Every route requires an authenticated member; conversation ownership is
// enforced in the controller on every history request.
router.use(protect);

router.get('/status', getAiStatus);
router.get('/conversations', listConversations);
router.post('/conversations', createConversation);
router.get('/conversations/:id', getConversation);
router.post('/conversations/:id/messages', sendConversationMessage);
router.post('/conversations/:id/attachments', aiAttachmentUpload, validateAiImageContent, uploadAttachments);
router.delete('/conversations/:id', deleteConversation);

module.exports = router;
