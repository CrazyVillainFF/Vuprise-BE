const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const State = require('../models/PasswordResetState');
const Counter = require('../models/PasswordResetCounter');
const { completePasswordReset } = require('../controllers/passwordResetController');
const { createResetToken, hashResetToken } = require('../utils/passwordResetSecurity');

const withMocks = async (configure, run) => {
  const originals = {
    updateOne: Counter.updateOne, findOneAndUpdateCounter: Counter.findOneAndUpdate,
    findOneAndUpdateState: State.findOneAndUpdate, findById: User.findById
  };
  const oldPepper = process.env.PASSWORD_RESET_PEPPER;
  process.env.PASSWORD_RESET_PEPPER = 'test-only-pepper';
  Counter.updateOne = async () => ({ acknowledged: true });
  Counter.findOneAndUpdate = async () => ({ windowStartedAt: new Date() });
  try { configure(); await run(); }
  finally {
    Counter.updateOne = originals.updateOne; Counter.findOneAndUpdate = originals.findOneAndUpdateCounter;
    State.findOneAndUpdate = originals.findOneAndUpdateState; User.findById = originals.findById;
    if (oldPepper === undefined) delete process.env.PASSWORD_RESET_PEPPER; else process.env.PASSWORD_RESET_PEPPER = oldPepper;
  }
};

const invoke = async (body) => {
  const result = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await completePasswordReset({ body, ip: '127.0.0.1' }, result, (error) => { throw error; });
  return result;
};

test('password reset rejects mismatched passwords before consuming a reset token', async () => {
  await withMocks(() => {}, async () => {
    const response = await invoke({ resetToken: createResetToken(), newPassword: 'password123', confirmPassword: 'different123' });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /do not match/);
  });
});

test('password reset atomically consumes a valid token and revokes existing sessions', async () => {
  const user = { tokenVersion: 3, password: '', save: async function save() { this.saved = true; } };
  await withMocks(() => {
    State.findOneAndUpdate = async (filter, update) => {
      assert.equal(filter.resetTokenHash, hashResetToken(token, 'test-only-pepper'));
      assert.ok(filter.resetTokenExpiresAt.$gt instanceof Date);
      assert.equal(filter.consumedAt, null);
      assert.equal(update.$set.resetTokenHash, '');
      return { user: 'user-id' };
    };
    User.findById = () => ({ select: async () => user });
  }, async () => {
    const response = await invoke({ resetToken: token, newPassword: 'new-password-123', confirmPassword: 'new-password-123' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(user.tokenVersion, 4);
    assert.equal(user.password, 'new-password-123');
    assert.equal(user.saved, true);
  });
});

test('expired or already-used password reset tokens are rejected', async () => {
  await withMocks(() => { State.findOneAndUpdate = async () => null; }, async () => {
    const response = await invoke({ resetToken: createResetToken(), newPassword: 'new-password-123', confirmPassword: 'new-password-123' });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /invalid or expired/);
  });
});

// Deterministic valid token for the atomic-consumption test above.
const token = createResetToken();
