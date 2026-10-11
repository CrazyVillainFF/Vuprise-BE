const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const { blockUser, unblockUser } = require('../controllers/userController');
const { canViewUserPosts, postVisibilityFilter } = require('../utils/postVisibility');

const ids = {
  viewer: '507f1f77bcf86cd799439011',
  author: '507f1f77bcf86cd799439012'
};
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('blocking validates a target and stores it only once', async () => {
  const originalExists = User.exists;
  const originalUpdateOne = User.updateOne;
  let update;
  User.exists = async ({ _id }) => String(_id) === ids.author;
  User.updateOne = async (...args) => { update = args; };
  try {
    const res = response();
    await blockUser({ params: { id: ids.author }, user: { _id: ids.viewer } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(update[1], { $addToSet: { blockedUsers: ids.author } });
    assert.equal(res.body.blockedUserId, ids.author);
  } finally {
    User.exists = originalExists;
    User.updateOne = originalUpdateOne;
  }
});

test('blocking rejects invalid ids, self-blocks, and missing accounts', async () => {
  const originalExists = User.exists;
  User.exists = async () => null;
  try {
    const invalid = response();
    await blockUser({ params: { id: 'not-an-id' }, user: { _id: ids.viewer } }, invalid, (error) => { throw error; });
    assert.equal(invalid.statusCode, 400);

    const self = response();
    await blockUser({ params: { id: ids.viewer }, user: { _id: ids.viewer } }, self, (error) => { throw error; });
    assert.equal(self.statusCode, 400);

    const missing = response();
    await blockUser({ params: { id: ids.author }, user: { _id: ids.viewer } }, missing, (error) => { throw error; });
    assert.equal(missing.statusCode, 404);
  } finally {
    User.exists = originalExists;
  }
});

test('unblocking removes only the selected blocked account', async () => {
  const originalUpdateOne = User.updateOne;
  let update;
  User.updateOne = async (...args) => { update = args; };
  try {
    const res = response();
    await unblockUser({ params: { id: ids.author }, user: { _id: ids.viewer } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(update[1], { $pull: { blockedUsers: ids.author } });
  } finally {
    User.updateOne = originalUpdateOne;
  }
});

test('blocked authors are excluded from post queries and cannot be viewed by the blocker', async () => {
  const originals = { find: User.find, findById: User.findById, exists: User.exists };
  User.find = () => ({ select: () => ({ lean: async () => [] }) });
  User.findById = () => ({ select: () => ({ lean: async () => ({ blockedUsers: [ids.author] }) }) });
  User.exists = async (filter) => filter._id === ids.viewer && filter.blockedUsers === ids.author;
  try {
    assert.deepEqual(await postVisibilityFilter(ids.viewer), { author: { $nin: [ids.author] } });
    assert.equal(await canViewUserPosts(ids.viewer, { _id: ids.author, privateAccount: false }), false);
    assert.equal(await canViewUserPosts(ids.viewer, { _id: ids.viewer, privateAccount: false }), true);
  } finally {
    User.find = originals.find;
    User.findById = originals.findById;
    User.exists = originals.exists;
  }
});
