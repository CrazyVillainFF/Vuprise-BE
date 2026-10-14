const otherParticipantId = (connection, viewerId) => {
  const viewer = String(viewerId || '');
  if (String(connection.requester) === viewer) return String(connection.recipient);
  if (String(connection.recipient) === viewer) return String(connection.requester);
  return '';
};

const connectionStatusesForViewer = (connections = [], viewerId) => connections.reduce((statuses, connection) => {
  const otherId = otherParticipantId(connection, viewerId);
  if (!otherId) return statuses;

  if (connection.status === 'accepted') statuses[otherId] = 'connected';
  else if (connection.status === 'pending') {
    statuses[otherId] = String(connection.requester) === String(viewerId) ? 'pending_sent' : 'pending_received';
  }
  return statuses;
}, {});

module.exports = { connectionStatusesForViewer };
