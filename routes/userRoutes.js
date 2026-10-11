const express = require('express');
const router = express.Router();
const {
  getUsers,
  getSuggestedUsers,
  getUserById,
  updateProfile,
  uploadAvatar,
  uploadCover,
  searchUsers,
  updateSettings,
  blockUser,
  unblockUser,
  getBlockedUsers
} = require('../controllers/userController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { upload, validateImageContent } = require('../middleware/uploadMiddleware');

router.get('/', optionalAuth, getUsers);
router.get('/search', optionalAuth, searchUsers);
router.get('/suggested', protect, getSuggestedUsers);
router.get('/blocked', protect, getBlockedUsers);
router.put('/:id/block', protect, blockUser);
router.delete('/:id/block', protect, unblockUser);
router.put('/profile', protect, updateProfile);
router.post('/avatar', protect, upload.single('avatar'), validateImageContent, uploadAvatar);
router.post('/cover', protect, upload.single('cover'), validateImageContent, uploadCover);
router.put('/settings', protect, updateSettings);
router.get('/:id', optionalAuth, getUserById);

module.exports = router;
