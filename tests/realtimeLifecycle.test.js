const test = require('node:test');
const assert = require('node:assert/strict');
const hub = require('../realtime/presenceHub');
const User = require('../models/User');
const Connection = require('../models/Connection');
const Conversation = require('../models/Conversation');
const Group = require('../models/Group');
const { logout, watchPresence } = require('../controllers/realtimeController');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const stream = () => ({
  destroyed: false,
  writableEnded: false,
  write() { return true; },
  end() { this.writableEnded = true; },
});

test('realtime logout is idempotent and never ends another account\u2019s session', async () => {
  const originalUpdateOne = User.updateOne;
  const updates = [];
  User.updateOne = async (filter, update) => { updates.push({ filter, update }); return { acknowledged: true }; };
  try {
    const owner = hub.createSession({ _id: 'lifecycle-owner', name: 'Owner' }, stream());
    const intruder = hub.createSession({ _id: 'lifecycle-intruder', name: 'Intruder' }, stream());

    const unknown = response();
    await logout({ body: { sessionId: 'missing-session-id' }, user: { _id: 'lifecycle-owner' } }, unknown, (error) => { throw error; });
    assert.equal(unknown.statusCode, 200);
    assert.equal(unknown.body.success, true);

    const foreign = response();
    await logout({ body: { sessionId: owner.id }, user: { _id: 'lifecycle-intruder' } }, foreign, (error) => { throw error; });
    assert.equal(foreign.statusCode, 200);
    assert.equal(hub.getSession(owner.id)?.id, owner.id, 'another account must not end an owned session');

    const first = response();
    await logout({ body: { sessionId: owner.id }, user: { _id: 'lifecycle-owner' } }, first, (error) => { throw error; });
    assert.equal(first.statusCode, 200);
    assert.equal(hub.getSession(owner.id), undefined);
    assert.equal(updates.length, 1, 'last seen persisted once when the final session ends');

    const retry = response();
    await logout({ body: { sessionId: owner.id }, user: { _id: 'lifecycle-owner' } }, retry, (error) => { throw error; });
    assert.equal(retry.statusCode, 200);
    assert.equal(updates.length, 1, 'a repeated logout does not repeat the last-seen write');

    hub.removeSession(intruder);
  } finally {
    User.updateOne = originalUpdateOne;
  }
});

test('presence watch authenticates a live session and reports an expired one as a retryable 401', async () => {
  const models = [Connection, Conversation, Group, User];
  const originals = models.map((model) => model.find);
  Connection.find = () => ({ select: () => ({ lean: async () => [] }) });
  Conversation.find = () => ({ select: () => ({ lean: async () => [] }) });
  Group.find = () => ({ select: () => ({ lean: async () => [] }) });
  User.find = () => ({ select: async () => [] });
  try {
    const expired = response();
    await watchPresence({ body: { sessionId: 'expired-session-id', userIds: ['507f1f77bcf86cd799439011'] }, user: { _id: '507f1f77bcf86cd799439012' } }, expired, (error) => { throw error; });
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.body.success, false);
    assert.match(expired.body.message, /expired/i);

    const session = hub.createSession({ _id: '507f1f77bcf86cd799439012', name: 'Watcher' }, stream());
    const live = response();
    await watchPresence({ body: { sessionId: session.id, userIds: ['507f1f77bcf86cd799439011'] }, user: { _id: '507f1f77bcf86cd799439012' } }, live, (error) => { throw error; });
    assert.equal(live.statusCode, 200);
    assert.equal(live.body.success, true);
    assert.equal(live.body.watching, 0);
    hub.removeSession(session);
  } finally {
    models.forEach((model, index) => { model.find = originals[index]; });
  }
});

test('watch replacement is rejected once a session has ended and removal stays idempotent', () => {
  const session = hub.createSession({ _id: 'lifecycle-watcher', name: 'Watcher' }, stream());
  assert.equal(hub.replaceWatches('lifecycle-watcher', session.id, ['someone']), true);
  hub.removeSession(session);
  assert.equal(hub.replaceWatches('lifecycle-watcher', session.id, ['someone']), false, 'an ended session can no longer watch');
  assert.equal(hub.removeSession(session), false, 'removing an ended session again is safe');
});
