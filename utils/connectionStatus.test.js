const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionStatusesForViewer } = require('./connectionStatus');

test('returns a connection status for the other participant only', () => {
  const statuses = connectionStatusesForViewer([
    { requester: 'viewer', recipient: 'accepted', status: 'accepted' },
    { requester: 'viewer', recipient: 'outgoing', status: 'pending' },
    { requester: 'incoming', recipient: 'viewer', status: 'pending' },
    { requester: 'elsewhere-a', recipient: 'elsewhere-b', status: 'accepted' },
  ], 'viewer');

  assert.deepEqual(statuses, {
    accepted: 'connected',
    outgoing: 'pending_sent',
    incoming: 'pending_received',
  });
});
