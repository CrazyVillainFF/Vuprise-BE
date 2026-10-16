const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const State = require('../models/PasswordResetState');
const Counter = require('../models/PasswordResetCounter');
const { requestPasswordReset, completePasswordReset } = require('../controllers/passwordResetController');

const runRequest = async (knownUser, options = {}) => {
  const envKeys = ['JWT_SECRET', 'PASSWORD_RESET_PEPPER', 'CLIENT_URL', 'BREVO_API_KEY', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const original = { findOne: User.findOne, stateUpdate: State.findOneAndUpdate, stateClear: State.updateOne, counterUpdate: Counter.updateOne, counterFind: Counter.findOneAndUpdate, fetch: global.fetch };
  let storedUpdate; let clearedState; let releasedCounter; let emailPayload; let requestUrl; let requestOptions;
  Object.assign(process.env, { JWT_SECRET: 'test-jwt-secret', PASSWORD_RESET_PEPPER: 'test-pepper', CLIENT_URL: options.clientUrl ?? 'https://nexora-lac-three.vercel.app', BREVO_API_KEY: 'test-brevo-key', PASSWORD_RESET_FROM: options.from ?? 'vupriseofficial@gmail.com' });
  User.findOne = () => ({ select: async () => knownUser });
  State.findOneAndUpdate = async (_filter, update) => { storedUpdate = update; return {}; };
  State.updateOne = async (_filter, update) => { clearedState = update; return { acknowledged: true }; };
  Counter.updateOne = async (_filter, update) => { releasedCounter = update; return { acknowledged: true }; };
  Counter.findOneAndUpdate = async () => ({ windowStartedAt: new Date() });
  global.fetch = async (url, init) => {
    requestUrl = url; requestOptions = init; emailPayload = JSON.parse(init.body);
    if (options.throwProviderError) throw options.throwProviderError;
    const error = options.providerError;
    return { ok: !error, status: error?.status || (error ? 400 : 201), json: async () => error ? error : { messageId: 'test-id' } };
  };
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    await requestPasswordReset({ body: { email: knownUser ? knownUser.email : 'unknown@example.test', ...(options.extraBody || {}) }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    return { response, storedUpdate, clearedState, releasedCounter, emailPayload, requestUrl, requestOptions };
  } finally {
    User.findOne = original.findOne; State.findOneAndUpdate = original.stateUpdate; State.updateOne = original.stateClear; Counter.updateOne = original.counterUpdate; Counter.findOneAndUpdate = original.counterFind; global.fetch = original.fetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};

test('recovery sends a six-digit OTP through Brevo and stores only its peppered digest', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' });
  assert.equal(result.response.statusCode, 200);
  assert.match(result.response.body.message, /If an account matches/);
  assert.equal(result.requestUrl, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(result.requestOptions.method, 'POST');
  assert.equal(result.requestOptions.headers['api-key'], 'test-brevo-key');
  assert.equal(result.emailPayload.sender.email, 'vupriseofficial@gmail.com');
  assert.deepEqual(result.emailPayload.to, [{ email: 'permitted-test-recipient@example.test' }]);
  const code = result.emailPayload.textContent.match(/code is (\d{6})/)[1];
  assert.match(result.storedUpdate.$set.codeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(result.storedUpdate.$set.codeHash, code);
  assert.ok(result.storedUpdate.$set.codeExpiresAt.getTime() > Date.now());
  assert.equal(result.storedUpdate.$set.verificationAttempts, 0);
  assert.equal(result.storedUpdate.$set.resetTokenHash, '');
  assert.equal(JSON.stringify(result.response.body).includes(code), false);
});

test('sender is configurable', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' }, { from: 'help@example.com' });
  assert.equal(result.emailPayload.sender.email, 'help@example.com');
});

test('Brevo recipient rejection is reported, OTP is invalidated, and no success response is returned', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'restricted-recipient@example.test' }, {
    providerError: { code: 'invalid_parameter', message: 'recipient email is not authorized' }
  });
  assert.equal(result.response.statusCode, 502);
  assert.equal(result.response.body.code, 'recipient_not_permitted');
  assert.match(result.response.body.message, /Brevo rejected the recipient/);
  assert.match(JSON.stringify(result.clearedState), /codeHash/);
  assert.equal(JSON.stringify(result.response.body).includes(result.storedUpdate.$set.codeHash), false);
});

test('Brevo sender rejection reports no delivery and exposes no provider details', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' }, {
    providerError: { code: 'invalid_parameter', message: 'sender domain is not verified; private diagnostic' }
  });
  assert.equal(result.response.statusCode, 502);
  assert.equal(result.response.body.code, 'sender_rejected');
  assert.match(result.response.body.message, /verify that sender in Brevo/);
  assert.equal(JSON.stringify(result.response.body).includes('private diagnostic'), false);
});

test('Brevo network failures invalidate the token and never return a fake success', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'person@example.test' }, { throwProviderError: new Error('network unavailable') });
  assert.equal(result.response.statusCode, 502);
  assert.equal(result.response.body.success, false);
  assert.equal(result.response.body.code, 'provider_rejected');
  assert.match(JSON.stringify(result.clearedState), /codeHash/);
});

test('the legacy verification endpoint that returned a reset token is not exposed', () => {
  const authRoutes = require('../routes/authRoutes');
  const routes = authRoutes.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.equal(routes.includes('/password-reset/verify'), false);
  assert.equal(typeof require('../controllers/passwordResetController').verifyPasswordResetCode, 'undefined');
});

test('unknown addresses receive the same generic confirmation and no email is sent', async () => {
  const result = await runRequest(null);
  assert.equal(result.response.statusCode, 200);
  assert.match(result.response.body.message, /If an account matches/);
  assert.equal(result.emailPayload, undefined);
  assert.equal(result.storedUpdate, undefined);
  const knownResult = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' });
  assert.deepEqual(result.response.body, knownResult.response.body);
});

test('recovery honeypot keeps the silent generic response without sending mail', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' }, { extraBody: { website: 'https://spam.example' } });
  assert.equal(result.response.statusCode, 200);
  assert.match(result.response.body.message, /If an account matches/);
  assert.equal(result.emailPayload, undefined);
  assert.equal(result.storedUpdate, undefined);
  assert.equal(result.releasedCounter, undefined);
});

test('completion honeypot is rejected as an invalid code without consuming counters', async () => {
  const originalCounterUpdate = Counter.updateOne;
  const originalCounterFindOne = Counter.findOneAndUpdate;
  let counterTouched = false;
  Counter.updateOne = async () => { counterTouched = true; return { acknowledged: true }; };
  Counter.findOneAndUpdate = async () => { counterTouched = true; return { windowStartedAt: new Date() }; };
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    await completePasswordReset({ body: { website: 'https://spam.example', email: 'user@example.test', code: '123456', newPassword: 'newpassword123', confirmPassword: 'newpassword123' }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.success, false);
    assert.equal(counterTouched, false);
  } finally {
    Counter.updateOne = originalCounterUpdate;
    Counter.findOneAndUpdate = originalCounterFindOne;
  }
});
