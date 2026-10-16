const test = require('node:test');
const assert = require('node:assert/strict');
const Connection = require('../models/Connection');
const User = require('../models/User');
const { evaluateDirectMessagePermission, getMessagePermission } = require('./directMessagePermissions');

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

test('public accounts allow a first message but private accounts and rejected relationships do not', () => {
  const publicResult = evaluateDirectMessagePermission({ connection: null, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: false });
  assert.equal(publicResult.allowed, true);
  assert.equal(publicResult.mode, 'public-new-conversation');
  assert.equal(evaluateDirectMessagePermission({ connection: null, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: true }).allowed, false);
  assert.equal(evaluateDirectMessagePermission({ connection: { ...pending, status: 'rejected' }, initiatorId: 'a', peerId: 'b', recipientPrivateAccount: false }).allowed, false);
});

test('a public recipient can reply to a non-connected private member who started the conversation', () => {
  // Member B (private) started the conversation with public member A. A must
  // still be able to open the inbox entry and reply, otherwise the recipient
  // side of a permitted first message silently disappears.
  const reply = evaluateDirectMessagePermission({
    connection: null,
    initiatorId: 'a',
    peerId: 'b',
    recipientPrivateAccount: true,
    conversationInitiatedBy: 'b'
  });
  assert.equal(reply.allowed, true);
  assert.equal(reply.mode, 'existing-permitted-conversation');
});

test('an existing non-connected conversation stays available to the member who started it', () => {
  const result = evaluateDirectMessagePermission({
    connection: null,
    initiatorId: 'a',
    peerId: 'b',
    recipientPrivateAccount: false,
    conversationInitiatedBy: 'a'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'existing-permitted-conversation');
});

test('an existing conversation does not let a private recipient start brand-new non-connected threads', () => {
  const otherConversation = evaluateDirectMessagePermission({
    connection: null,
    initiatorId: 'a',
    peerId: 'b',
    recipientPrivateAccount: true,
    conversationInitiatedBy: null
  });
  assert.equal(otherConversation.allowed, false);
});

test('blocked members cannot message each other even when both accounts are public', async () => {
  const viewer = '507f1f77bcf86cd799439011';
  const blocked = '507f1f77bcf86cd799439012';
  const originals = { findById: User.findById, findOne: Connection.findOne };
  Connection.findOne = () => ({ select: () => ({ lean: async () => null }) });
  try {
    User.findById = (id) => ({
      select: () => ({
        lean: async () => (String(id) === viewer
          ? { _id: viewer, privateAccount: false, blockedUsers: [blocked] }
          : { _id: blocked, privateAccount: false, blockedUsers: [] })
      })
    });
    const denied = await getMessagePermission({ initiatorId: viewer, peerId: blocked });
    assert.equal(denied.allowed, false);

    User.findById = (id) => ({
      select: () => ({
        lean: async () => (String(id) === viewer
          ? { _id: viewer, privateAccount: false, blockedUsers: [] }
          : { _id: blocked, privateAccount: false, blockedUsers: [viewer] })
      })
    });
    const reverseDenied = await getMessagePermission({ initiatorId: viewer, peerId: blocked });
    assert.equal(reverseDenied.allowed, false);
  } finally {
    User.findById = originals.findById;
    Connection.findOne = originals.findOne;
  }
});
