const test = require('node:test');
const assert = require('node:assert/strict');
const hub = require('../realtime/presenceHub');

const stream = () => ({
  writes: [],
  destroyed: false,
  writableEnded: false,
  write(value) { this.writes.push(value); return true; },
  end() { this.writableEnded = true; },
});
const events = (target, type) => target.writes.flatMap((frame) => {
  const event = frame.match(/^event: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  if (!data || event !== type) return [];
  return [JSON.parse(data)];
});

test('multiple authenticated realtime sessions stay online until the last one closes; stale heartbeat expires', () => {
  const first = hub.createSession({ _id: 'presence-user-a', name: 'A', hideActivity: false }, stream());
  const second = hub.createSession({ _id: 'presence-user-a', name: 'A', hideActivity: false }, stream());
  assert.equal(hub.getSessionCount('presence-user-a'), 2);
  assert.equal(hub.heartbeat('presence-user-b', first.id), false);
  hub.removeSession(first);
  assert.equal(hub.getSessionCount('presence-user-a'), 1);
  second.lastHeartbeatAt = Date.now() - hub.HEARTBEAT_TTL_MS - 1;
  hub.expireStaleSessions();
  assert.equal(hub.getSessionCount('presence-user-a'), 0);
  assert.equal(hub.heartbeat('presence-user-a', second.id), false);
});

test('presence watches receive only hidden or current state and privacy changes clear prior status', () => {
  const ownerStream = stream();
  const viewerStream = stream();
  const owner = hub.createSession({ _id: 'presence-private-owner', name: 'Owner', hideActivity: true }, ownerStream);
  const viewer = hub.createSession({ _id: 'presence-private-viewer', name: 'Viewer', hideActivity: false }, viewerStream);
  assert.equal(hub.replaceWatches(viewer.userId, viewer.id, [owner.userId]), true);
  assert.equal(events(viewerStream, 'presence').at(-1).state, 'hidden');
  hub.setHidden(owner.userId, false);
  assert.equal(events(viewerStream, 'presence').at(-1).state, 'online');
  hub.setHidden(owner.userId, true);
  assert.equal(events(viewerStream, 'presence').at(-1).state, 'hidden');
  hub.removeSession(owner);
  assert.equal(events(viewerStream, 'presence').at(-1).state, 'hidden');
  hub.removeSession(viewer);
});

test('typing events are scoped to the authorized recipients without message content or presence metadata', () => {
  const recipientStream = stream();
  const unrelatedStream = stream();
  const recipient = hub.createSession({ _id: 'typing-recipient', name: 'Recipient' }, recipientStream);
  const unrelated = hub.createSession({ _id: 'typing-unrelated', name: 'Other' }, unrelatedStream);
  hub.setTyping({ scopeId: 'conversation-1', scopeType: 'conversation', senderId: 'typing-sender', senderName: 'Sender', recipients: [recipient.userId], active: true });
  const [event] = events(recipientStream, 'typing');
  assert.equal(event.scopeId, 'conversation-1');
  assert.equal(event.userId, 'typing-sender');
  assert.equal(event.active, true);
  assert.equal('text' in event, false);
  assert.equal('state' in event, false);
  assert.equal(events(unrelatedStream, 'typing').length, 0);
  hub.setTyping({ scopeId: 'conversation-1', scopeType: 'conversation', senderId: 'typing-sender', senderName: 'Sender', recipients: [recipient.userId], active: false });
  assert.equal(events(recipientStream, 'typing').at(-1).active, false);
  hub.removeSession(recipient);
  hub.removeSession(unrelated);
});
