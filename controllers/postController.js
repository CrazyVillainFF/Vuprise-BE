const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const User = require('../models/User');
const fs = require('fs/promises');
const { processUploadedMedia, deleteUploadedMedia } = require('../middleware/uploadMiddleware');
const { canViewUserPosts, isBlockedBy, postVisibilityFilter, addPostVisibility } = require('../utils/postVisibility');

const savePostMedia = async (file, req, body = {}) => {
  if (!file) return null;
  if (!file.mimetype?.startsWith('image/')) {
    await fs.unlink(file.path).catch(() => {});
    const error = new Error('Videos must use the secure direct-upload flow.');
    error.statusCode = 415;
    throw error;
  }
  const image = await processUploadedMedia(file, req, 'posts');
  return { mediaType: 'image', image: image.url, imagePublicId: image.publicId, videoUrl: '', videoPublicId: '', videoSourceUrl: '', videoSourcePublicId: '', videoDuration: null, videoThumbnail: '' };
};

const removePostMedia = async (post) => {
  await Promise.all([
    deleteUploadedMedia({ publicId: post.imagePublicId, url: post.image, resourceType: 'image' }),
    deleteUploadedMedia({ publicId: post.videoPublicId, url: post.videoUrl, resourceType: 'video' }),
    deleteUploadedMedia({ publicId: post.videoSourcePublicId, url: post.videoSourceUrl, resourceType: 'video' })
  ]);
};

// @desc    Create a new post
// @route   POST /api/posts
// @access  Private
const createPost = async (req, res, next) => {
  let media;
  let created = false;
  try {
    const rawContent = req.body.content;
    if (rawContent !== undefined && (typeof rawContent !== 'string' || rawContent.length > 5000)) return res.status(400).json({ success: false, message: 'Post text must be 5000 characters or fewer.' });
    const content = typeof rawContent === 'string' ? rawContent.trim() : '';
    media = await savePostMedia(req.file, req, req.body);

    if (!content && !media) {
      return res.status(400).json({
        success: false,
        message: 'A post must contain text, an image, or a video.'
      });
    }

    // Extract hashtags if any
    let tags = [];
    if (content) {
      const matches = content.match(/#[a-zA-Z0-9_]+/g);
      if (matches) {
        tags = matches.map(t => t.substring(1).toLowerCase());
      }
    }

    const post = await Post.create({
      author: req.user._id,
      content,
      ...(media || {}),
      tags
    });
    created = true;

    const populatedPost = await Post.findById(post._id)
      .populate('author', 'name headline profilePicture company jobTitle location');

    const postObj = populatedPost.toObject();
    postObj.isLiked = false;
    postObj.likeCount = 0;
    postObj.commentCount = 0;

    res.status(201).json({
      success: true,
      message: 'Post published successfully.',
      post: postObj
    });
  } catch (error) {
    if (!created) {
      if (media) await removePostMedia(media).catch(() => {});
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
};

// @desc    Get home feed posts
// @route   GET /api/posts/feed
// @access  Public / Optional Auth
const getFeed = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;
    const tag = req.query.tag;

    let query = {};
    if (tag) {
      query.tags = tag.toLowerCase();
    }

    query = addPostVisibility(query, await postVisibilityFilter(req.user?._id));

    const total = await Post.countDocuments(query);
    const posts = await Post.find(query)
      .populate('author', 'name headline profilePicture company jobTitle location')
      .populate({
        path: 'comments',
        populate: {
          path: 'author',
          select: 'name headline profilePicture'
        },
        options: { sort: { createdAt: -1 }, limit: 3 }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Add isLiked status relative to authenticated user
    const formattedPosts = posts.map(p => {
      const pObj = p.toObject();
      pObj.likeCount = p.likes ? p.likes.length : 0;
      pObj.commentCount = p.comments ? p.comments.length : 0;
      pObj.isLiked = req.user ? p.likes.some(id => id.toString() === req.user._id.toString()) : false;
      return pObj;
    });

    res.status(200).json({
      success: true,
      count: formattedPosts.length,
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      posts: formattedPosts
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get posts by user ID
// @route   GET /api/posts/user/:userId
// @access  Public / Optional Auth
const getUserPosts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const skip = (page - 1) * limit;

    const profileOwner = await User.findById(req.params.userId).select('privateAccount _id');
    if (!profileOwner) return res.status(404).json({ success: false, message: 'Profile not found.' });
    if (await isBlockedBy(req.user?._id, profileOwner._id)) return res.status(404).json({ success: false, message: 'Posts not found.' });
    if (!(await canViewUserPosts(req.user?._id, profileOwner))) {
      return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });
    }
    const query = { author: req.params.userId };
    const total = await Post.countDocuments(query);

    const posts = await Post.find(query)
      .populate('author', 'name headline profilePicture company jobTitle location')
      .populate({
        path: 'comments',
        populate: {
          path: 'author',
          select: 'name headline profilePicture'
        },
        options: { sort: { createdAt: -1 }, limit: 3 }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const formattedPosts = posts.map(p => {
      const pObj = p.toObject();
      pObj.likeCount = p.likes ? p.likes.length : 0;
      pObj.commentCount = p.comments ? p.comments.length : 0;
      pObj.isLiked = req.user ? p.likes.some(id => id.toString() === req.user._id.toString()) : false;
      return pObj;
    });

    res.status(200).json({
      success: true,
      count: formattedPosts.length,
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      posts: formattedPosts
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single post by ID
// @route   GET /api/posts/:id
// @access  Public / Optional Auth
const getPostById = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'name headline profilePicture company jobTitle location')
      .populate({
        path: 'comments',
        populate: {
          path: 'author',
          select: 'name headline profilePicture'
        },
        options: { sort: { createdAt: 1 } }
      });

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found.'
      });
    }

    const owner = await User.findById(post.author).select('privateAccount _id');
    if (await isBlockedBy(req.user?._id, owner?._id)) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (!(await canViewUserPosts(req.user?._id, owner))) {
      return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });
    }

    const pObj = post.toObject();
    pObj.likeCount = post.likes ? post.likes.length : 0;
    pObj.commentCount = post.comments ? post.comments.length : 0;
    pObj.isLiked = req.user ? post.likes.some(id => id.toString() === req.user._id.toString()) : false;

    res.status(200).json({
      success: true,
      post: pObj
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a post
// @route   PUT /api/posts/:id
// @access  Private
const updatePost = async (req, res, next) => {
  try {
    let post = await Post.findById(req.params.id).select('+videoSourceUrl +videoSourcePublicId +videoSourceDuration +videoTrimStart +videoTrimEnd');

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found.'
      });
    }

    const owner = await User.findById(post.author).select('privateAccount _id');
    if (!(await canViewUserPosts(req.user?._id, owner))) {
      return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });
    }

    // Check authorization: only author can update
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to edit this post.'
      });
    }

    const previousMedia = {
      image: post.image, imagePublicId: post.imagePublicId,
      videoUrl: post.videoUrl, videoPublicId: post.videoPublicId,
      videoSourceUrl: post.videoSourceUrl, videoSourcePublicId: post.videoSourcePublicId
    };

    const rawContent = req.body.content;
    if (rawContent !== undefined && (typeof rawContent !== 'string' || rawContent.length > 5000)) return res.status(400).json({ success: false, message: 'Post text must be 5000 characters or fewer.' });
    const content = typeof rawContent === 'string' ? rawContent.trim() : undefined;
    if (content !== undefined) {
      post.content = content;
      const matches = content.match(/#[a-zA-Z0-9_]+/g);
      post.tags = matches ? matches.map(t => t.substring(1).toLowerCase()) : [];
    }

    const keepsCurrentMedia = req.body.removeMedia !== 'true' && Boolean(post.image || post.videoUrl);
    if (!String(post.content || '').trim() && !req.file && !keepsCurrentMedia) return res.status(400).json({ success: false, message: 'A post must contain text, an image, or a video.' });

    let nextMedia = null;
    if (req.file) {
      nextMedia = await savePostMedia(req.file, req, req.body);
      post.set(nextMedia);
    } else if (req.body.removeMedia === 'true') {
      post.set({ mediaType: 'image', image: '', imagePublicId: '', videoUrl: '', videoPublicId: '', videoSourceUrl: '', videoSourcePublicId: '', videoSourceDuration: null, videoDuration: null, videoTrimStart: 0, videoTrimEnd: null, videoThumbnail: '' });
    }

    try { await post.save(); }
    catch (saveError) {
      if (nextMedia) await removePostMedia({ ...nextMedia }).catch(() => {});
      throw saveError;
    }

    if (nextMedia || req.body.removeMedia === 'true') await removePostMedia(previousMedia).catch((cleanupError) => console.error('[Post media cleanup]', cleanupError.message));

    const updated = await Post.findById(post._id)
      .populate('author', 'name headline profilePicture company jobTitle location');

    const pObj = updated.toObject();
    delete pObj.videoSourceUrl;
    delete pObj.videoSourcePublicId;
    delete pObj.videoSourceDuration;
    delete pObj.videoTrimStart;
    delete pObj.videoTrimEnd;
    pObj.isLiked = updated.likes.some(id => id.toString() === req.user._id.toString());
    pObj.likeCount = updated.likes.length;
    pObj.commentCount = updated.comments.length;

    res.status(200).json({
      success: true,
      message: 'Post updated successfully.',
      post: pObj
    });
  } catch (error) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
};

// @desc    Delete a post
// @route   DELETE /api/posts/:id
// @access  Private
const deletePost = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id).select('+videoSourceUrl +videoSourcePublicId');

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found.'
      });
    }

    // Check authorization
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to delete this post.'
      });
    }

    // Delete associated comments and notifications
    await Comment.deleteMany({ post: post._id });
    await Notification.deleteMany({ post: post._id });
    await Post.findByIdAndDelete(post._id);
    await removePostMedia(post).catch((cleanupError) => console.error('[Post media cleanup]', cleanupError.message));

    res.status(200).json({
      success: true,
      message: 'Post deleted successfully.'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle like / unlike on a post
// @route   POST /api/posts/:id/like
// @access  Private
const toggleLikePost = async (req, res, next) => {
  try {
    const post = await Post.findById(req.params.id);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found.'
      });
    }

    const owner = await User.findById(post.author).select('privateAccount _id');
    if (!(await canViewUserPosts(req.user._id, owner))) {
      return res.status(403).json({ success: false, privateAccount: true, message: 'This account is private.' });
    }

    const userId = req.user._id;
    const isLiked = post.likes.some(id => id.toString() === userId.toString());

    if (isLiked) {
      // Unlike
      post.likes = post.likes.filter(id => id.toString() !== userId.toString());
    } else {
      // Like
      post.likes.push(userId);

      // Create notification for post author (if not self)
      if (post.author.toString() !== userId.toString()) {
        await Notification.create({
          recipient: post.author,
          sender: userId,
          type: 'post_like',
          post: post._id,
          message: `${req.user.name} liked your post.`
        });
      }
    }

    await post.save();

    res.status(200).json({
      success: true,
      liked: !isLiked,
      likeCount: post.likes.length
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createPost,
  getFeed,
  getUserPosts,
  getPostById,
  updatePost,
  deletePost,
  toggleLikePost
};
