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

test('the reported repro appeal is accepted while signed out and persisted for review', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  const originalFindOne = User.findOne;
  const originalExists = SupportRequest.exists;
  const originalCreate = SupportRequest.create;
  let created = null;
  User.findOne = () => ({ select: () => ({ lean: async () => null }) });
  SupportRequest.exists = async () => null;
  SupportRequest.create = async (payload) => { created = payload; return { _id: 'request-repro' }; };
  try {
    const res = response();
    await createRequest({
      body: {
        type: 'temporary_ban_appeal',
        email: 'appeal@example.com',
        subject: 'Account got ban',
        message: 'Hello, My Account was temporarily banned but no reason please unban'
      },
      ip: 'test-appeal-repro',
      files: []
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(created.type, 'temporary_ban_appeal');
    assert.equal(created.subject, 'Account got ban');
    assert.equal(created.status, 'pending');
    assert.equal(created.user, null);
  } finally {
    User.findOne = originalFindOne;
    SupportRequest.exists = originalExists;
    SupportRequest.create = originalCreate;
    limiter.restore();
  }
});

test('a free-text account user ID such as a name is accepted and never used as identity proof', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  const originalFindOne = User.findOne;
  const originalFindById = User.findById;
  const originalExists = SupportRequest.exists;
  const originalCreate = SupportRequest.create;
  let created = null;
  let findByIdCalls = 0;
  User.findById = () => { findByIdCalls += 1; return { select: async () => null }; };
  User.findOne = () => ({ select: () => ({ lean: async () => null }) });
  SupportRequest.exists = async () => null;
  SupportRequest.create = async (payload) => { created = payload; return { _id: 'request-name' }; };
  try {
    const res = response();
    await createRequest({ body: appealBody({ userId: 'Archana' }), ip: 'test-appeal-name', files: [] }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(created.user, null);
    assert.equal(findByIdCalls, 0);
  } finally {
    User.findOne = originalFindOne;
    User.findById = originalFindById;
    SupportRequest.exists = originalExists;
    SupportRequest.create = originalCreate;
    limiter.restore();
  }
});

test('validation failures return field-specific messages instead of one generic error', async () => {
  const limiter = installRateLimitCounter({ windowMs: 60 * 60 * 1000, max: 5 });
  try {
    const badType = response();
    await createRequest({ body: appealBody({ type: 'temporary ban appeal' }), ip: 'test-appeal-v1', files: [] }, badType, (error) => { throw error; });
    assert.equal(badType.statusCode, 400);
    assert.equal(badType.body.message, 'Request type: please select a valid option.');

    const shortSubject = response();
    await createRequest({ body: appealBody({ subject: 'ab' }), ip: 'test-appeal-v2', files: [] }, shortSubject, (error) => { throw error; });
    assert.equal(shortSubject.statusCode, 400);
    assert.equal(shortSubject.body.message, 'Subject: enter at least 3 characters.');

    const shortMessage = response();
    await createRequest({ body: appealBody({ message: 'too short' }), ip: 'test-appeal-v3', files: [] }, shortMessage, (error) => { throw error; });
    assert.equal(shortMessage.statusCode, 400);
    assert.equal(shortMessage.body.message, 'Message: enter at least 10 characters.');

    const badEmail = response();
    await createRequest({ body: appealBody({ email: 'not-an-email' }), ip: 'test-appeal-v4', files: [] }, badEmail, (error) => { throw error; });
    assert.equal(badEmail.statusCode, 400);
    assert.equal(badEmail.body.message, 'Email: enter a valid email address.');

    const longUserId = response();
    await createRequest({ body: appealBody({ userId: 'x'.repeat(121) }), ip: 'test-appeal-v5', files: [] }, longUserId, (error) => { throw error; });
    assert.equal(longUserId.statusCode, 400);
    assert.equal(longUserId.body.message, 'Account user ID: keep it under 120 characters.');
  } finally {
    limiter.restore();
  }
});
