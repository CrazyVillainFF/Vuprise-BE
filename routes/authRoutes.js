const express = require('express');
const router = express.Router();
const { register, login, getMe, updatePassword } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { requestPasswordReset, completePasswordReset } = require('../controllers/passwordResetController');

router.post('/register', register);
router.post('/login', login);
router.get('/me', protect, getMe);
router.put('/updatepassword', protect, updatePassword);
router.post('/password-reset/request', requestPasswordReset);
router.post('/password-reset/complete', completePasswordReset);

module.exports = router;
