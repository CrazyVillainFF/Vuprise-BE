const Comment = require('../models/Comment');
const Post = require('../models/Post');
const Notification = require('../models/Notification');
const { canViewUserPosts } = require('../utils/postVisibility');

const authorFields = 'name headline profilePicture company jobTitle isVerifiedAccount verificationBadgeColor';
const sameId = (left, right) => String(left) === String(right);

const serializeComment = (comment, viewerId) => {
  const value = comment.toObject ? comment.toObject() : comment;
  const likes = Array.isArray(value.likes) ? value.likes : [];
  return {
    ...value,
    likeCount: likes.length,
    isLiked: Boolean(viewerId && likes.some((id) => sameId(id?._id || id, viewerId))),
    likes: undefined
  };
};

// @desc    Add comment to a post
// @route   POST /api/posts/:postId/comments
// @access  Private
const addComment = async (req, res, next) => {
  try {
    const { content } = req.body;
    const { postId } = req.params;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Comment content cannot be empty.'
      });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found.'
      });
    }

    if (!(await canViewUserPosts(req.user._id, await require('../models/User').findById(post.author).select('privateAccount _id')))) {
      return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });
    }

    const comment = await Comment.create({
      post: postId,
      author: req.user._id,
      content: content.trim()
    });

    // Add comment to post's comments array
    post.comments.push(comment._id);
    await post.save();

    const populatedComment = await Comment.findById(comment._id)
      .populate('author', authorFields);

    // Notifications are best-effort: the comment is already saved, so a
    // notification hiccup must not turn a successful save into an error
    // response (which would prompt a duplicate retry from the client).
    if (post.author.toString() !== req.user._id.toString()) {
      try {
        await Notification.create({
          recipient: post.author,
          sender: req.user._id,
          type: 'post_comment',
          post: post._id,
          message: `${req.user.name} commented on your post: "${content.trim().substring(0, 40)}${content.length > 40 ? '...' : ''}"`
        });
      } catch (notificationError) {
        console.warn('[Post comment] Notification could not be created:', notificationError.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Comment added successfully.',
      comment: serializeComment(populatedComment, req.user._id),
      commentCount: post.comments.length
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all comments for a post
// @route   GET /api/posts/:postId/comments
// @access  Public / Optional Auth
const getPostComments = async (req, res, next) => {
  try {
    const { postId } = req.params;

    const post = await Post.findById(postId).select('author');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    const author = await require('../models/User').findById(post.author).select('privateAccount _id');
    if (!(await canViewUserPosts(req.user?._id, author))) {
      return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });
    }

    const comments = await Comment.find({ post: postId })
      .select('author content likes pinned pinnedAt createdAt updatedAt')
      .populate('author', authorFields)
      .sort({ pinned: -1, createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      count: comments.length,
      comments: comments.map((comment) => serializeComment(comment, req.user?._id))
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a comment
// @route   DELETE /api/comments/:id
// @access  Private
const deleteComment = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.id);

    if (!comment) {
      return res.status(404).json({
        success: false,
        message: 'Comment not found.'
      });
    }

    const post = await Post.findById(comment.post);

    // Authorization: only comment author or post author can delete
    const isCommentAuthor = comment.author.toString() === req.user._id.toString();
    const isPostAuthor = post && post.author.toString() === req.user._id.toString();

    if (!isCommentAuthor && !isPostAuthor) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to delete this comment.'
      });
    }

    // Remove from post comments array
    if (post) {
      post.comments = post.comments.filter(id => id.toString() !== comment._id.toString());
      await post.save();
    }

    await Comment.findByIdAndDelete(comment._id);

    res.status(200).json({
      success: true,
      message: 'Comment deleted successfully.',
      commentCount: post ? post.comments.length : 0
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Edit a comment
// @route   PUT /api/comments/:id
// @access  Private (comment author only)
const updateComment = async (req, res, next) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ success: false, message: 'Comment content cannot be empty.' });
    if (content.length > 1000) return res.status(400).json({ success: false, message: 'Comment cannot exceed 1000 characters.' });

    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found.' });
    if (comment.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You are not authorized to edit this comment.' });
    }

    comment.content = content;
    await comment.save();
    const updatedComment = await Comment.findById(comment._id)
      .populate('author', authorFields);

    res.status(200).json({ success: true, message: 'Comment updated successfully.', comment: serializeComment(updatedComment, req.user._id) });
  } catch (error) {
    next(error);
  }
};

// @desc    Like or unlike a comment
// @route   PUT /api/comments/:id/like
const toggleCommentLike = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.id).select('post author likes');
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found.' });
    const post = await Post.findById(comment.post).select('author');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    const postAuthor = await require('../models/User').findById(post.author).select('privateAccount _id');
    if (!(await canViewUserPosts(req.user._id, postAuthor))) return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });

    const existing = comment.likes.findIndex((id) => sameId(id, req.user._id));
    const liked = existing === -1;
    if (liked) comment.likes.push(req.user._id);
    else comment.likes.splice(existing, 1);
    await comment.save();
    return res.status(200).json({ success: true, liked, likeCount: comment.likes.length });
  } catch (error) { return next(error); }
};

// @desc    Pin or unpin a comment (post author only)
// @route   PUT /api/comments/:id/pin
const toggleCommentPin = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found.' });
    const post = await Post.findById(comment.post).select('author');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (!sameId(post.author, req.user._id)) return res.status(403).json({ success: false, message: 'Only the post author can pin a comment.' });

    const pinned = !comment.pinned;
    if (pinned) await Comment.updateMany({ post: comment.post, pinned: true }, { $set: { pinned: false, pinnedAt: null } });
    comment.pinned = pinned;
    comment.pinnedAt = pinned ? new Date() : null;
    await comment.save();
    const populated = await Comment.findById(comment._id).populate('author', authorFields);
    return res.status(200).json({ success: true, pinned, comment: serializeComment(populated, req.user._id) });
  } catch (error) { return next(error); }
};

module.exports = {
  addComment,
  getPostComments,
  deleteComment,
  updateComment,
  toggleCommentLike,
  toggleCommentPin
};
