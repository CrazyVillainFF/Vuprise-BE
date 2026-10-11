const test = require('node:test');
const assert = require('node:assert/strict');
const { createResetToken, isResetToken, createResetCode, hashResetToken, safeHashEquals } = require('../utils/passwordResetSecurity');

test('password reset tokens are cryptographically random URL-safe values', () => {
  const first = createResetToken(); const second = createResetToken();
  assert.equal(first.length, 43); assert.equal(isResetToken(first), true); assert.notEqual(first, second);
});

test('password reset OTPs are six-digit cryptographically generated values', () => {
  for (let attempt = 0; attempt < 100; attempt += 1) assert.match(createResetCode(), /^\d{6}$/);
});

test('only the stored digest matches; malformed reset tokens are rejected', () => {
  const token = createResetToken(); const hash = hashResetToken(token, 'test-pepper');
  assert.equal(safeHashEquals(hashResetToken(token, 'test-pepper'), hash), true);
  assert.equal(safeHashEquals(hashResetToken(token, 'different-pepper'), hash), false);
  assert.equal(isResetToken('hardcoded-token'), false);
  assert.equal(safeHashEquals('not-hex', hash), false);
});
