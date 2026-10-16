const test = require('node:test');
const assert = require('node:assert/strict');
const Post = require('../models/Post');
const User = require('../models/User');
const Comment = require('../models/Comment');
const Notification = require('../models/Notification');
const { toggleLikePost } = require('../controllers/postController');
const { addComment } = require('../controllers/commentController');

const response = () => ({ statusCode: 200, body: null, status(statusCode) { this.statusCode = statusCode; return this; }, json(body) { this.body = body; return this; } });

test('post likes persist and unlike removes only the current user even when notifications fail', async () => {
  const originals = { postFindById: Post.findById, userFindById: User.findById, userExists: User.exists, notificationCreate: Notification.create };
  const authorId = '507f1f77bcf86cd799439201';
  const likerId = '507f1f77bcf86cd799439202';
  const otherId = '507f1f77bcf86cd799439203';
  const post = { _id: '507f1f77bcf86cd799439204', author: authorId, likes: [otherId], save: async () => {} };
  Post.findById = async () => post;
  User.findById = () => ({ select: async () => ({ _id: authorId, privateAccount: false }) });
  User.exists = async () => false;
  Notification.create = async () => { throw new Error('notification store unavailable'); };
  try {
    const likeRes = response();
    await toggleLikePost({ params: { id: post._id }, user: { _id: likerId, name: 'Liker' } }, likeRes, (error) => { throw error; });
    assert.equal(likeRes.statusCode, 200);
    assert.equal(likeRes.body.liked, true);
    assert.equal(likeRes.body.likeCount, 2);
    assert.deepEqual(post.likes, [otherId, likerId]);

    const unlikeRes = response();
    await toggleLikePost({ params: { id: post._id }, user: { _id: likerId, name: 'Liker' } }, unlikeRes, (error) => { throw error; });
    assert.equal(unlikeRes.statusCode, 200);
    assert.equal(unlikeRes.body.liked, false);
    assert.equal(unlikeRes.body.likeCount, 1);
    assert.deepEqual(post.likes, [otherId]);
  } finally {
    Post.findById = originals.postFindById;
    User.findById = originals.userFindById;
    User.exists = originals.userExists;
    Notification.create = originals.notificationCreate;
  }
});

test('comments with emojis are saved and confirmed even when the author notification fails', async () => {
  const originals = { postFindById: Post.findById, userFindById: User.findById, userExists: User.exists, commentCreate: Comment.create, commentFindById: Comment.findById, notificationCreate: Notification.create };
  const authorId = '507f1f77bcf86cd799439211';
  const commenterId = '507f1f77bcf86cd799439212';
  const postId = '507f1f77bcf86cd799439213';
  const commentId = '507f1f77bcf86cd799439214';
  const post = { _id: postId, author: authorId, comments: [], save: async () => {} };
  Post.findById = async () => post;
  User.findById = () => ({ select: async () => ({ _id: authorId, privateAccount: false }) });
  User.exists = async () => false;
  Comment.create = async (payload) => ({ _id: commentId, ...payload });
  Comment.findById = () => ({ populate: async () => ({ _id: commentId, post: postId, author: { _id: commenterId, name: 'Commenter' }, content: 'Nice reel 🔥🎬', likes: [] }) });
  Notification.create = async () => { throw new Error('notification store unavailable'); };
  try {
    const empty = response();
    await addComment({ params: { postId }, body: { content: '   ' }, user: { _id: commenterId, name: 'Commenter' } }, empty, (error) => { throw error; });
    assert.equal(empty.statusCode, 400);

    const res = response();
    await addComment({ params: { postId }, body: { content: 'Nice reel 🔥🎬' }, user: { _id: commenterId, name: 'Commenter' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.comment.content, 'Nice reel 🔥🎬');
    assert.equal(res.body.comment.likeCount, 0);
    assert.equal(res.body.commentCount, 1);
    assert.equal(post.comments.length, 1);
  } finally {
    Post.findById = originals.postFindById;
    User.findById = originals.userFindById;
    User.exists = originals.userExists;
    Comment.create = originals.commentCreate;
    Comment.findById = originals.commentFindById;
    Notification.create = originals.notificationCreate;
  }
});
