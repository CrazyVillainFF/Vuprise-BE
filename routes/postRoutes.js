const express = require('express');
const router = express.Router();
const {
  createPost,
  getFeed,
  getUserPosts,
  getPostById,
  updatePost,
  deletePost,
  toggleLikePost
} = require('../controllers/postController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { upload, postUpload, preparePostUpload, validateImageContent } = require('../middleware/uploadMiddleware');

router.post('/', protect, postUpload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), preparePostUpload, validateImageContent, createPost);
router.get('/feed', optionalAuth, getFeed);
router.get('/user/:userId', optionalAuth, getUserPosts);
router.get('/:id', optionalAuth, getPostById);
router.put('/:id', protect, postUpload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), preparePostUpload, validateImageContent, updatePost);
router.delete('/:id', protect, deletePost);
router.post('/:id/like', protect, toggleLikePost);

module.exports = router;
