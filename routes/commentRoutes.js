const express = require('express');
const router = express.Router();
const {
  addComment,
  getPostComments,
  deleteComment,
  updateComment,
  toggleCommentLike,
  toggleCommentPin
} = require('../controllers/commentController');
const { protect, optionalAuth } = require('../middleware/authMiddleware');

// Post-nested comment routes
router.post('/:postId/comments', protect, addComment);
router.get('/:postId/comments', optionalAuth, getPostComments);

// Standalone comment deletion
router.put('/:id', protect, updateComment);
router.put('/:id/like', protect, toggleCommentLike);
router.put('/:id/pin', protect, toggleCommentPin);
router.delete('/:id', protect, deleteComment);

module.exports = router;
