const test = require('node:test');
const assert = require('node:assert/strict');
const { isVerifiedAccount } = require('../utils/verifiedAccount');

test('designated email remains verified unless an admin has explicitly overridden the badge', () => {
  assert.equal(isVerifiedAccount('vishnubangaru001@gmail.com'), true);
  assert.equal(isVerifiedAccount(' VISHNUBANGARU001@GMAIL.COM '), true);
  assert.equal(isVerifiedAccount({ email: 'vishnubangaru001@gmail.com', isVerifiedAccount: false }), false);
  assert.equal(isVerifiedAccount({ email: 'someone@example.com', isVerifiedAccount: true }), true);
  assert.equal(isVerifiedAccount('member@example.com'), false);
  assert.equal(isVerifiedAccount(undefined), false);
});
