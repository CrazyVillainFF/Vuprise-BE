const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const controller = require('../controllers/realtimeController');

const router = express.Router();
router.use(protect);
router.get('/events', controller.events);
router.post('/heartbeat', controller.heartbeat);
router.post('/watch', controller.watchPresence);
router.post('/logout', controller.logout);
router.post('/typing/conversations/:id/start', controller.typing('conversation'));
router.post('/typing/conversations/:id/stop', controller.typing('conversation'));
router.post('/typing/groups/:id/start', controller.typing('group'));
router.post('/typing/groups/:id/stop', controller.typing('group'));
module.exports = router;
