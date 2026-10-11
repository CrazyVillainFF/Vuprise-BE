const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const State = require('../models/PasswordResetState');
const Counter = require('../models/PasswordResetCounter');
const { completePasswordReset } = require('../controllers/passwordResetController');
const { hashResetToken } = require('../utils/passwordResetSecurity');

const originals = {
  counterUpdate: Counter.updateOne,
  counterFind: Counter.findOneAndUpdate,
  stateUpdate: State.findOneAndUpdate,
  stateClear: State.updateOne,
  userFind: User.findOne,
  userById: User.findById
};
const email = 'person@example.test';
const userId = '507f1f77bcf86cd799439011';
const activeState = { _id: 'state-id', user: userId, verificationAttempts: 1 };

const invoke = async (body) => {
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await completePasswordReset({ body, ip: '127.0.0.1' }, response, (error) => { throw error; });
  return response;
};

const withMocks = async (configure, run) => {
  const oldPepper = process.env.PASSWORD_RESET_PEPPER;
  process.env.PASSWORD_RESET_PEPPER = 'test-only-pepper';
  Counter.updateOne = async () => ({ acknowledged: true });
  Counter.findOneAndUpdate = async () => ({ windowStartedAt: new Date() });
  User.findOne = () => ({ select: async () => ({ _id: userId }) });
  State.updateOne = async () => ({ acknowledged: true });
  try { configure(); await run(); }
  finally {
    Counter.updateOne = originals.counterUpdate;
    Counter.findOneAndUpdate = originals.counterFind;
    State.findOneAndUpdate = originals.stateUpdate;
    State.updateOne = originals.stateClear;
    User.findOne = originals.userFind;
    User.findById = originals.userById;
    if (oldPepper === undefined) delete process.env.PASSWORD_RESET_PEPPER; else process.env.PASSWORD_RESET_PEPPER = oldPepper;
  }
};

const validPayload = (code = '012345') => ({ email, code, newPassword: 'new-password-123', confirmPassword: 'new-password-123' });

test('password reset rejects mismatched passwords without consuming an OTP', async () => {
  await withMocks(() => { State.findOneAndUpdate = async () => assert.fail('OTP must not be consumed'); }, async () => {
    const response = await invoke({ ...validPayload(), confirmPassword: 'different123' });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /do not match/);
  });
});

test('password reset atomically consumes a valid OTP and revokes existing sessions', async () => {
  const user = { tokenVersion: 3, password: '', save: async function save() { this.saved = true; } };
  await withMocks(() => {
    State.findOneAndUpdate = async (filter, update) => {
      assert.equal(filter.user, userId);
      assert.equal(filter.codeHash, hashResetToken('012345', 'test-only-pepper'));
      assert.ok(filter.codeExpiresAt.$gt instanceof Date);
      assert.equal(filter.consumedAt, null);
      assert.equal(filter.verificationAttempts.$lt, 5);
      assert.equal(update.$set.codeHash, '');
      assert.ok(update.$set.consumedAt instanceof Date);
      return { ...activeState, user: userId };
    };
    User.findById = () => ({ select: async () => user });
  }, async () => {
    const response = await invoke(validPayload());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(user.tokenVersion, 4);
    assert.equal(user.password, 'new-password-123');
    assert.equal(user.saved, true);
  });
});

test('wrong OTP increments attempts and fifth failure invalidates the code', async () => {
  const seen = []; let wrongAttempt = 0; let invalidated;
  await withMocks(() => {
    State.findOneAndUpdate = async (filter, update) => {
      seen.push({ filter, update });
      if (update.$inc) {
        wrongAttempt += 1;
        return { ...activeState, verificationAttempts: wrongAttempt };
      }
      return null;
    };
    State.updateOne = async (filter, update) => { invalidated = { filter, update }; return { acknowledged: true }; };
  }, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await invoke(validPayload('999999'));
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.message, 'The reset code is invalid, expired, or has reached its attempt limit.');
    }
  });
  assert.equal(wrongAttempt, 5);
  assert.equal(seen.length, 10);
  assert.equal(seen[1].update.$inc.verificationAttempts, 1);
  assert.equal(seen[1].filter.verificationAttempts.$lt, 5);
  assert.equal(invalidated.update.$set.codeHash, '');
  assert.ok(invalidated.update.$set.consumedAt instanceof Date);
  assert.equal(invalidated.filter.verificationAttempts.$gte, 5);
  assert.equal(JSON.stringify(invalidated.filter).includes(hashResetToken('999999', 'test-only-pepper')), false);
});

test('expired, consumed, and exhausted OTPs are rejected without account enumeration', async () => {
  const stateQueries = [];
  await withMocks(() => {
    User.findOne = () => ({ select: async () => null });
    State.findOneAndUpdate = async (filter, update) => { stateQueries.push({ filter, update }); return null; };
  }, async () => {
    const unknown = await invoke(validPayload());
    assert.equal(unknown.statusCode, 400);
    User.findOne = () => ({ select: async () => ({ _id: userId }) });
    const expired = await invoke(validPayload());
    assert.equal(expired.statusCode, 400);
    assert.equal(expired.body.message, unknown.body.message);
    assert.equal(stateQueries[0].filter.codeExpiresAt.$gt instanceof Date, true);
    assert.equal(stateQueries[0].filter.consumedAt, null);
    assert.equal(stateQueries[1].filter.codeExpiresAt.$gt instanceof Date, true);
    assert.equal(stateQueries[1].filter.consumedAt, null);
  });
});

test('malformed OTPs are rejected and legacy email-link payloads are not accepted', async () => {
  await withMocks(() => {}, async () => {
    const malformed = await invoke(validPayload('12ab56'));
    assert.equal(malformed.statusCode, 400);
    const legacy = await invoke({ resetToken: 'old-link-token', newPassword: 'new-password-123', confirmPassword: 'new-password-123' });
    assert.equal(legacy.statusCode, 400);
    assert.equal(legacy.body.message, malformed.body.message);
  });
});
