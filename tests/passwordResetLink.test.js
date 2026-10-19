const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const State = require('../models/PasswordResetState');
const RateLimitCounter = require('../models/RateLimitCounter');
const { createResetToken, hashResetToken } = require('../utils/passwordResetSecurity');

const originals = {
  userFindOne: User.findOne,
  userFindById: User.findById,
  stateFindOneAndUpdate: State.findOneAndUpdate,
  stateUpdateOne: State.updateOne,
  rateUpdateOne: RateLimitCounter.updateOne,
  rateFindOneAndUpdate: RateLimitCounter.findOneAndUpdate,
  fetch: global.fetch
};

const userId = '507f1f77bcf86cd799439011';
const account = { _id: userId, email: 'person@example.test' };
const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

const withEnvironment = async (run) => {
  const keys = ['BREVO_API_KEY', 'SENDER_EMAIL', 'PASSWORD_RESET_PEPPER', 'CLIENT_URL'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    BREVO_API_KEY: 'test-api-key',
    SENDER_EMAIL: 'vupriseoffical@gmail.com',
    PASSWORD_RESET_PEPPER: 'test-reset-pepper',
    CLIENT_URL: 'https://app.example.test'
  });
  RateLimitCounter.updateOne = async () => ({ acknowledged: true });
  RateLimitCounter.findOneAndUpdate = async () => ({ _id: 'counter', count: 1, windowStartedAt: new Date() });
  try { await run(); }
  finally {
    User.findOne = originals.userFindOne;
    User.findById = originals.userFindById;
    State.findOneAndUpdate = originals.stateFindOneAndUpdate;
    State.updateOne = originals.stateUpdateOne;
    RateLimitCounter.updateOne = originals.rateUpdateOne;
    RateLimitCounter.findOneAndUpdate = originals.rateFindOneAndUpdate;
    global.fetch = originals.fetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

test('forgot-password sends a Brevo reset link and stores only a hashed 30-minute token', async () => {
  await withEnvironment(async () => {
    const { forgotPassword } = require('../controllers/passwordResetLinkController');
    let storedUpdate;
    let payload;
    User.findOne = () => ({ select: async () => account });
    State.findOneAndUpdate = async (_filter, update) => { storedUpdate = update; return {}; };
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['api-key'], 'test-api-key');
      payload = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'brevo-message-id' }) };
    };

    const response = makeResponse();
    await forgotPassword({ body: { email: account.email }, ip: '127.0.0.1' }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.message, 'If that email exists, we sent a reset link.');
    assert.deepEqual(payload.sender, { name: 'Vups', email: 'vupriseoffical@gmail.com' });
    assert.deepEqual(payload.to, [{ email: account.email }]);
    assert.equal(payload.subject, 'Reset your password');
    assert.match(payload.htmlContent, /Reset Password/);
    assert.match(payload.htmlContent, /expires in 30 minutes/i);
    const link = payload.htmlContent.match(/href="([^"]+)"/)[1];
    const url = new URL(link);
    const token = url.searchParams.get('token');
    assert.equal(url.origin, 'https://app.example.test');
    assert.equal(url.pathname, '/reset-password');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(storedUpdate.$set.resetTokenHash, hashResetToken(token, process.env.PASSWORD_RESET_PEPPER));
    assert.notEqual(storedUpdate.$set.resetTokenHash, token);
    assert.ok(storedUpdate.$set.resetTokenExpiresAt.getTime() > Date.now());
    assert.ok(storedUpdate.$set.resetTokenExpiresAt.getTime() <= Date.now() + 30 * 60 * 1000 + 1000);
    assert.equal(storedUpdate.$set.codeHash, '');
  });
});

test('forgot-password returns the same generic response for an unknown email without sending email', async () => {
  await withEnvironment(async () => {
    const { forgotPassword } = require('../controllers/passwordResetLinkController');
    User.findOne = () => ({ select: async () => null });
    let sent = false;
    global.fetch = async () => { sent = true; throw new Error('should not send'); };
    const response = makeResponse();
    await forgotPassword({ body: { email: 'unknown@example.test' }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.message, 'If that email exists, we sent a reset link.');
    assert.equal(sent, false);
  });
});

test('reset-password consumes a valid unexpired token, hashes the new password through the model, and increments tokenVersion', async () => {
  await withEnvironment(async () => {
    const { resetPassword } = require('../controllers/passwordResetLinkController');
    const token = createResetToken();
    let consumedFilter;
    let consumedUpdate;
    const state = { user: userId };
    State.findOneAndUpdate = async (filter, update) => {
      consumedFilter = filter;
      consumedUpdate = update;
      return state;
    };
    let saved = false;
    const user = {
      password: 'old-hash',
      tokenVersion: 4,
      async save() { saved = true; }
    };
    User.findById = () => ({ select: async () => user });

    const response = makeResponse();
    await resetPassword({ body: { token, newPassword: 'new-password-123', confirmPassword: 'new-password-123' }, ip: '127.0.0.1' }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(user.password, 'new-password-123');
    assert.equal(user.tokenVersion, 5);
    assert.equal(saved, true);
    assert.equal(consumedFilter.resetTokenHash, hashResetToken(token, process.env.PASSWORD_RESET_PEPPER));
    assert.ok(consumedFilter.resetTokenExpiresAt.$gt instanceof Date);
    assert.equal(consumedUpdate.$set.resetTokenHash, '');
    assert.equal(consumedUpdate.$set.resetTokenExpiresAt, null);
  });
});

test('reset-password rejects malformed tokens and weak passwords', async () => {
  await withEnvironment(async () => {
    const { resetPassword } = require('../controllers/passwordResetLinkController');
    let queried = false;
    State.findOneAndUpdate = async () => { queried = true; return null; };
    const response = makeResponse();
    await resetPassword({ body: { token: 'bad-token', newPassword: 'short', confirmPassword: 'short' }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.success, false);
    assert.equal(queried, false);
  });
});

test('email delivery failure invalidates the reset token and preserves the generic response', async () => {
  await withEnvironment(async () => {
    const { forgotPassword } = require('../controllers/passwordResetLinkController');
    let savedHash = '';
    let invalidated = false;
    User.findOne = () => ({ select: async () => account });
    State.findOneAndUpdate = async (_filter, update) => { savedHash = update.$set.resetTokenHash; return {}; };
    State.updateOne = async (filter, update) => {
      invalidated = filter.resetTokenHash === savedHash && update.$set.resetTokenHash === '';
      return { acknowledged: true };
    };
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'unauthorized' }) });
    const response = makeResponse();
    await forgotPassword({ body: { email: account.email }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.message, 'If that email exists, we sent a reset link.');
    assert.equal(invalidated, true);
  });
});
