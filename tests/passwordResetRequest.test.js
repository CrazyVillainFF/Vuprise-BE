const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const User = require('../models/User');
const State = require('../models/PasswordResetState');
const Counter = require('../models/PasswordResetCounter');
const { requestPasswordReset } = require('../controllers/passwordResetController');

const runRequest = async (knownUser) => {
  const savedEnv = Object.fromEntries(['JWT_SECRET', 'PASSWORD_RESET_PEPPER', 'CLIENT_URL', 'RESEND_API_KEY'].map((key) => [key, process.env[key]]));
  const original = { findOne: User.findOne, stateUpdate: State.findOneAndUpdate, counterUpdate: Counter.updateOne, counterFind: Counter.findOneAndUpdate, load: Module._load };
  let storedUpdate; let emailPayload;
  Object.assign(process.env, { JWT_SECRET: 'test-jwt-secret', PASSWORD_RESET_PEPPER: 'test-pepper', CLIENT_URL: 'https://nexora-lac-three.vercel.app', RESEND_API_KEY: 're_test_only' });
  User.findOne = () => ({ select: async () => knownUser });
  State.findOneAndUpdate = async (_filter, update) => { storedUpdate = update; return {}; };
  Counter.updateOne = async () => ({ acknowledged: true });
  Counter.findOneAndUpdate = async () => ({ windowStartedAt: new Date() });
  Module._load = function load(request, parent, isMain) {
    if (request === 'resend') return { Resend: class FakeResend { constructor(key) { assert.equal(key, process.env.RESEND_API_KEY); this.emails = { send: async (payload) => { emailPayload = payload; return { data: { id: 'test-id' }, error: null }; } }; } } };
    return original.load.call(this, request, parent, isMain);
  };
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    await requestPasswordReset({ body: { email: knownUser ? knownUser.email : 'unknown@example.test' }, ip: '127.0.0.1' }, response, (error) => { throw error; });
    return { response, storedUpdate, emailPayload };
  } finally {
    User.findOne = original.findOne; State.findOneAndUpdate = original.stateUpdate; Counter.updateOne = original.counterUpdate; Counter.findOneAndUpdate = original.counterFind; Module._load = original.load;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};

test('recovery sends a generic reply and a hashed-token email via the Resend SDK', async () => {
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

test('unknown addresses receive the same generic confirmation and no email is sent', async () => {
  const result = await runRequest(null);
  assert.equal(result.response.statusCode, 200);
  assert.match(result.response.body.message, /If an account matches/);
  assert.equal(result.emailPayload, undefined);
  assert.equal(result.storedUpdate, undefined);
});
