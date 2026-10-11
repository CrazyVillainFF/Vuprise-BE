const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { upload, validateImageContent } = require('../middleware/uploadMiddleware');
const controller = require('../controllers/groupController');

router.use(protect);
router.get('/', controller.listGroups);
router.post('/', upload.single('image'), validateImageContent, controller.createGroup);
router.post('/:id/invitations/:action(accept|decline)', controller.respondInvitation);
router.post('/:id/invitations/:userId', controller.inviteMember);
router.patch('/:id/members/:userId/role', controller.setMemberRole);
router.delete('/:id/members/:userId', controller.removeMember);
router.get('/:id', controller.getGroup);
router.patch('/:id', upload.single('image'), validateImageContent, controller.updateGroup);
module.exports = router;
