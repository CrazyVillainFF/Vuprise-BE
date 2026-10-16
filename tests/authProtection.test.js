const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const { register, login } = require('../controllers/authController');
const { installRateLimitCounter } = require('./helpers/rateLimitCounterDouble');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('registration honeypot rejects automated submissions before any account lookup', async () => {
  const originalFindOne = User.findOne;
  let lookedUp = false;
  User.findOne = async () => { lookedUp = true; return null; };
  try {
    const res = response();
    await register({ body: { name: 'Bot', email: 'bot@example.com', password: 'password123', accountType: 'student', schoolName: 'Demo School', course: 'Demo Course', courseStartYear: 2024, website: 'https://spam.example' }, ip: 'test-reg-bot' }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(lookedUp, false);
  } finally {
    User.findOne = originalFindOne;
  }
});

test('registration attempts from one connection are limited per hour', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 20 });
  try {
    for (let i = 0; i < 20; i += 1) {
      const res = response();
      await register({ body: {}, ip: 'test-reg-limit' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 400);
    }
    const blocked = response();
    await register({ body: {}, ip: 'test-reg-limit' }, blocked, (error) => { throw error; });
    assert.equal(blocked.statusCode, 429);
  } finally {
    limiter.restore();
  }
});

test('sign-in honeypot responses match invalid credentials exactly', async () => {
  const originalFindOne = User.findOne;
  let lookedUp = false;
  User.findOne = async () => { lookedUp = true; return null; };
  try {
    const res = response();
    await login({ body: { email: 'user@example.com', password: 'whatever123', website: 'https://spam.example' }, ip: 'test-login-bot' }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'Invalid email or password. Please check your credentials and try again.');
    assert.equal(lookedUp, false);
  } finally {
    User.findOne = originalFindOne;
  }
});

test('repeated failed sign-ins are throttled per connection and email', async () => {
  const originalFindOne = User.findOne;
  const limiter = installRateLimitCounter({ windowMs: 15 * 60 * 1000, max: 10 });
  User.findOne = () => ({ select: async () => null });
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = response();
      await login({ body: { email: 'Target@Example.com', password: 'wrong-password' }, ip: 'test-login' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 401);
    }
    const blocked = response();
    await login({ body: { email: 'target@example.com', password: 'wrong-password' }, ip: 'test-login' }, blocked, (error) => { throw error; });
    assert.equal(blocked.statusCode, 429);
  } finally {
    User.findOne = originalFindOne;
    limiter.restore();
  }
});

test('sign-in for a temporarily banned account returns the exact server expiration', async () => {
  const originalFindOne = User.findOne;
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  User.findOne = () => ({
    select: async () => ({
      _id: 'user-temp-ban',
      email: 'suspended@example.com',
      moderationStatus: 'temporary_ban',
      moderationExpiresAt: expiresAt,
      moderationReason: 'Spam posting',
      matchPassword: async () => true
    })
  });
  try {
    const res = response();
    await login({ body: { email: 'suspended@example.com', password: 'correct-password' }, ip: 'test-login-temp-ban' }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'ACCOUNT_RESTRICTED');
    assert.equal(res.body.restriction.status, 'temporary_ban');
    assert.equal(res.body.restriction.expiresAt.toISOString(), expiresAt.toISOString());
    assert.equal(res.body.restriction.reason, 'Spam posting');
  } finally {
    User.findOne = originalFindOne;
  }
});

test('sign-in for a permanently banned account carries no expiration timestamp', async () => {
  const originalFindOne = User.findOne;
  User.findOne = () => ({
    select: async () => ({
      _id: 'user-perm-ban',
      email: 'banned@example.com',
      moderationStatus: 'permanent_ban',
      moderationReason: 'Repeated abuse',
      matchPassword: async () => true
    })
  });
  try {
    const res = response();
    await login({ body: { email: 'banned@example.com', password: 'correct-password' }, ip: 'test-login-perm-ban' }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'ACCOUNT_RESTRICTED');
    assert.equal(res.body.restriction.status, 'permanent_ban');
    assert.equal(res.body.restriction.expiresAt, undefined);
    assert.equal(res.body.message, 'Your account is permanently restricted.');
  } finally {
    User.findOne = originalFindOne;
  }
});

test('an expired temporary ban is cleared by the server and sign-in proceeds', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-ban-flow';
  const originalFindOne = User.findOne;
  const originalUpdateOne = User.updateOne;
  let clearedFilter = null;
  const user = {
    _id: 'user-expired-ban',
    name: 'Expired Ban',
    email: 'expired@example.com',
    tokenVersion: 0,
    moderationStatus: 'temporary_ban',
    moderationExpiresAt: new Date(Date.now() - 60 * 1000),
    moderationReason: 'Old restriction',
    matchPassword: async () => true,
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        email: this.email,
        tokenVersion: this.tokenVersion,
        moderationStatus: this.moderationStatus,
        moderationReason: this.moderationReason
      };
    }
  };
  User.findOne = () => ({ select: async () => user });
  User.updateOne = async (filter) => { clearedFilter = filter; return { acknowledged: true, modifiedCount: 1 }; };
  try {
    const res = response();
    await login({ body: { email: 'expired@example.com', password: 'correct-password' }, ip: 'test-login-expired-ban' }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.token);
    assert.equal(res.body.user.moderationStatus, undefined);
    assert.equal(clearedFilter.moderationStatus, 'temporary_ban');
    assert.ok(clearedFilter.moderationExpiresAt.$lte);
  } finally {
    User.findOne = originalFindOne;
    User.updateOne = originalUpdateOne;
  }
});
