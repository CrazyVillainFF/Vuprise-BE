const express = require('express');
const router = express.Router();
const {
  createPost,
  getFeed,
  getUserPosts,
  getPostById,
  updatePost,
  deletePost,
  toggleLikePost,
  togglePostReaction
} = require('../controllers/postController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');
const { postUpload, preparePostUpload, validateImageContent } = require('../middleware/uploadMiddleware');
const { signUpload, publishUploadedVideo } = require('../controllers/videoUploadController');

router.post('/video-upload/sign', protect, signUpload);
router.post('/video-upload/complete', protect, publishUploadedVideo);
router.post('/', protect, postUpload.single('image'), preparePostUpload, validateImageContent, createPost);
router.get('/feed', optionalAuth, getFeed);
router.get('/user/:userId', optionalAuth, getUserPosts);
router.get('/:id', optionalAuth, getPostById);
router.put('/:id', protect, postUpload.single('image'), preparePostUpload, validateImageContent, updatePost);
router.delete('/:id', protect, deletePost);
router.post('/:id/like', protect, toggleLikePost);
router.put('/:id/reactions', protect, togglePostReaction);

module.exports = router;
