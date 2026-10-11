const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const User = require('../models/User');
const State = require('../models/PasswordResetState');
const Counter = require('../models/PasswordResetCounter');
const { requestPasswordReset } = require('../controllers/passwordResetController');

const runRequest = async (knownUser, options = {}) => {
  const envKeys = ['JWT_SECRET', 'PASSWORD_RESET_PEPPER', 'CLIENT_URL', 'RESEND_API_KEY', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const original = { findOne: User.findOne, stateUpdate: State.findOneAndUpdate, stateClear: State.updateOne, counterUpdate: Counter.updateOne, counterFind: Counter.findOneAndUpdate, load: Module._load };
  let storedUpdate; let clearedState; let releasedCounter; let emailPayload;
  Object.assign(process.env, { JWT_SECRET: 'test-jwt-secret', PASSWORD_RESET_PEPPER: 'test-pepper', CLIENT_URL: options.clientUrl ?? 'https://nexora-lac-three.vercel.app', RESEND_API_KEY: 're_test_only', PASSWORD_RESET_FROM: options.from ?? 'onboarding@resend.dev' });
  User.findOne = () => ({ select: async () => knownUser });
  State.findOneAndUpdate = async (_filter, update) => { storedUpdate = update; return {}; };
  State.updateOne = async (_filter, update) => { clearedState = update; return { acknowledged: true }; };
  Counter.updateOne = async (_filter, update) => { releasedCounter = update; return { acknowledged: true }; };
  Counter.findOneAndUpdate = async () => ({ windowStartedAt: new Date() });
  Module._load = function load(request, parent, isMain) {
    if (request === 'resend') return { Resend: class FakeResend { constructor(key) { assert.equal(key, process.env.RESEND_API_KEY); this.emails = { send: async (payload) => { emailPayload = payload; if (options.throwProviderError) throw options.throwProviderError; return options.providerError ? { data: null, error: options.providerError } : { data: { id: 'test-id' }, error: null }; } }; } } };
    return original.load.call(this, request, parent, isMain);
  };
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    await requestPasswordReset({ body: { email: knownUser ? knownUser.email : 'unknown@example.test' }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    return { response, storedUpdate, clearedState, releasedCounter, emailPayload };
  } finally {
    User.findOne = original.findOne; State.findOneAndUpdate = original.stateUpdate; State.updateOne = original.stateClear; Counter.updateOne = original.counterUpdate; Counter.findOneAndUpdate = original.counterFind; Module._load = original.load;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};

test('recovery sends through Resend using configured sender and deployed Vercel reset origin', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' });
  assert.equal(result.response.statusCode, 200);
  assert.match(result.response.body.message, /If an account matches/);
  assert.equal(result.emailPayload.from, 'onboarding@resend.dev');
  assert.deepEqual(result.emailPayload.to, ['permitted-test-recipient@example.test']);
  const link = new URL(result.emailPayload.text.match(/https:\/\/[^\s]+/)[0]);
  assert.equal(link.origin, 'https://nexora-lac-three.vercel.app');
  assert.equal(link.pathname, '/forgot-password');
  assert.equal(link.searchParams.get('token').length, 43);
  assert.match(result.storedUpdate.$set.resetTokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(result.storedUpdate.$set.resetTokenHash, link.searchParams.get('token'));
  assert.equal(JSON.stringify(result.response.body).includes(link.searchParams.get('token')), false);
});

test('sender is configurable and missing CLIENT_URL falls back to the deployed Vercel origin', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' }, { from: 'Vuprise <help@example.com>', clientUrl: '' });
  assert.equal(result.emailPayload.from, 'Vuprise <help@example.com>');
  const link = new URL(result.emailPayload.text.match(/https:\/\/[^\s]+/)[0]);
  assert.equal(link.origin, 'https://nexora-lac-three.vercel.app');
});

test('Resend recipient rejection is reported, reset token is invalidated, and no success response is returned', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'restricted-recipient@example.test' }, {
    providerError: { name: 'validation_error', message: 'You can only send testing emails to your own email address' }
  });
  assert.equal(result.response.statusCode, 502);
  assert.equal(result.response.body.code, 'recipient_not_permitted');
  assert.match(result.response.body.message, /recipient must be permitted/);
  assert.match(JSON.stringify(result.clearedState), /resetTokenHash/);
  assert.equal(JSON.stringify(result.response.body).includes(result.storedUpdate.$set.resetTokenHash), false);
});

test('Resend sender rejection reports no delivery and exposes no provider details', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'permitted-test-recipient@example.test' }, {
    providerError: { name: 'validation_error', message: 'The from address domain is not verified; private diagnostic' }
  });
  assert.equal(result.response.statusCode, 502);
  assert.equal(result.response.body.code, 'sender_rejected');
  assert.match(result.response.body.message, /Check PASSWORD_RESET_FROM/);
  assert.equal(JSON.stringify(result.response.body).includes('private diagnostic'), false);
});

test('invalid password-reset website origins fail before querying or emailing accounts', async () => {
  const result = await runRequest({ _id: '507f1f77bcf86cd799439011', email: 'person@example.test' }, { clientUrl: 'javascript:alert(1)' });
  assert.equal(result.response.statusCode, 503);
  assert.equal(result.emailPayload, undefined);
  assert.equal(result.storedUpdate, undefined);
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
});
