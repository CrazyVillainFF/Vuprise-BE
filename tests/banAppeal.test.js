const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const SupportRequest = require('../models/SupportRequest');
const { createRequest } = require('../controllers/supportController');
const { installRateLimitCounter } = require('./helpers/rateLimitCounterDouble');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

const appealBody = (overrides = {}) => ({
  type: 'temporary_ban_appeal',
  email: 'Banned@Example.com',
  subject: 'Appeal my suspension',
  message: 'Please review the suspension on my account.',
  ...overrides
});

test('a signed-out ban appeal is linked to the banned account by its exact email', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  const originalFindOne = User.findOne;
  const originalExists = SupportRequest.exists;
  const originalCreate = SupportRequest.create;
  const accountId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  let created = null;
  User.findOne = () => ({ select: () => ({ lean: async () => ({ _id: accountId }) }) });
  SupportRequest.exists = async () => null;
  SupportRequest.create = async (payload) => { created = payload; return { _id: 'request-1' }; };
  try {
    const res = response();
    await createRequest({ body: appealBody(), ip: 'test-appeal', files: [] }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(created.type, 'temporary_ban_appeal');
    assert.equal(created.user, accountId);
    assert.equal(created.email, 'banned@example.com');
    assert.equal(created.status, 'pending');
  } finally {
    User.findOne = originalFindOne;
    SupportRequest.exists = originalExists;
    SupportRequest.create = originalCreate;
    limiter.restore();
  }
});

test('a supplied user ID that does not match the appeal email cannot hijack the link', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  const originalFindById = User.findById;
  const originalFindOne = User.findOne;
  const originalExists = SupportRequest.exists;
  const originalCreate = SupportRequest.create;
  const accountId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const otherId = 'cccccccccccccccccccccccc';
  let created = null;
  User.findById = () => ({ select: async () => ({ _id: otherId, email: 'attacker@example.com' }) });
  User.findOne = () => ({ select: () => ({ lean: async () => ({ _id: accountId }) }) });
  SupportRequest.exists = async () => null;
  SupportRequest.create = async (payload) => { created = payload; return { _id: 'request-2' }; };
  try {
    const res = response();
    await createRequest({ body: appealBody({ userId: otherId }), ip: 'test-appeal-id', files: [] }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(created.user, accountId);
  } finally {
    User.findById = originalFindById;
    User.findOne = originalFindOne;
    SupportRequest.exists = originalExists;
    SupportRequest.create = originalCreate;
    limiter.restore();
  }
});

test('a repeated identical appeal within the window is acknowledged without a second record', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  const originalExists = SupportRequest.exists;
  const originalCreate = SupportRequest.create;
  let createCalls = 0;
  SupportRequest.exists = async () => ({ _id: 'existing-request' });
  SupportRequest.create = async () => { createCalls += 1; return { _id: 'request-3' }; };
  try {
    const res = response();
    await createRequest({ body: appealBody(), ip: 'test-appeal-dup', files: [] }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Your request has been received.');
    assert.equal(createCalls, 0);
  } finally {
    SupportRequest.exists = originalExists;
    SupportRequest.create = originalCreate;
    limiter.restore();
  }
});
