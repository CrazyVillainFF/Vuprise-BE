const express = require('express');
const { protect, requireAdmin } = require('../middleware/authMiddleware');
const controller = require('../controllers/adminController');
const router = express.Router();

router.use(protect, requireAdmin);
router.get('/overview', controller.overview);
router.get('/users', controller.listUsers);
router.get('/users/:id', controller.userDetail);
router.get('/users/:id/posts', controller.userPosts);
router.put('/users/:id/verification', controller.setVerification);
router.post('/messages/broadcast', controller.broadcastMessage);
router.post('/users/:id/temporary-ban', controller.temporaryBan);
router.post('/users/:id/permanent-ban', controller.permanentBan);
router.post('/users/:id/lift-ban', controller.liftBan);
router.post('/users/:id/warnings', controller.addWarning);
router.post('/users/:id/delete', controller.deleteUser);
router.get('/requests', controller.listRequests);
router.get('/reports', controller.listReports);
router.get('/help', controller.listHelp);
router.patch('/inbox/:id', controller.updateInboxItem);

module.exports = router;
