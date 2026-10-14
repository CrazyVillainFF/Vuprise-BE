const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDirectMessagePermission } = require('./directMessagePermissions');

const pending = { requester: 'a', recipient: 'b', status: 'pending' };
const accepted = { ...pending, status: 'accepted' };

test('a one-way connection can start a message with a public recipient', () => {
  const result = evaluateDirectMessagePermission({ connection: pending, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: false });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'public-outbound');
});

test('a one-way connection cannot start a message with a private recipient', () => {
  const result = evaluateDirectMessagePermission({ connection: pending, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: true });
  assert.equal(result.allowed, false);
  assert.match(result.message, /connect back|message you first/i);
});

test('a private recipient can start the first message after an inbound connection', () => {
  const result = evaluateDirectMessagePermission({ connection: pending, initiatorId: 'b', peerId: 'a', recipientPrivateAccount: true });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'private-recipient-start');
});

test('both people can use an accepted mutual connection', () => {
  for (const initiatorId of ['a', 'b']) {
    const result = evaluateDirectMessagePermission({ connection: accepted, initiatorId, peerId: initiatorId === 'a' ? 'b' : 'a', recipientPrivateAccount: true });
    assert.equal(result.allowed, true);
    assert.equal(result.mode, 'mutual');
  }
});

test('a private recipient-started conversation lets the connector reply', () => {
  const result = evaluateDirectMessagePermission({
    connection: pending,
    initiatorId: 'a',
    peerId: 'b',
    recipientPrivateAccount: true,
    conversationInitiatedBy: 'b'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'existing-permitted-conversation');
});

test('missing and rejected relationships never grant a direct-message permission', () => {
  assert.equal(evaluateDirectMessagePermission({ connection: null, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: false }).allowed, false);
  assert.equal(evaluateDirectMessagePermission({ connection: { ...pending, status: 'rejected' }, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: false }).allowed, false);
});
