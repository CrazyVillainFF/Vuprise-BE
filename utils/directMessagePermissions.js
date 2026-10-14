const Connection = require('../models/Connection');
const User = require('../models/User');

const sameId = (left, right) => String(left) === String(right);

const messageDenied = (message) => ({ allowed: false, message });

// Kept pure so the policy is regression-testable without a database.
const evaluateDirectMessagePermission = ({ connection, initiatorId, peerId, recipientPrivateAccount, conversationInitiatedBy }) => {
  if (!connection) return messageDenied('Connect with this member before messaging.');
  if (connection.status === 'accepted') return { allowed: true, mode: 'mutual' };
  if (connection.status !== 'pending') return messageDenied('This connection is no longer available for messaging.');

  const initiatorIsRequester = sameId(connection.requester, initiatorId);
  const initiatorIsRecipient = sameId(connection.recipient, initiatorId);
  if (!initiatorIsRequester && !initiatorIsRecipient) return messageDenied('This connection is not available to you.');

  // A public recipient accepts a first message from the person who connected.
  if (!recipientPrivateAccount && initiatorIsRequester) return { allowed: true, mode: 'public-outbound' };
  // A private recipient must either connect back (accepted above) or choose to
  // start the conversation after somebody connected to them.
  if (recipientPrivateAccount && initiatorIsRecipient) return { allowed: true, mode: 'private-recipient-start' };

  // Once a permitted first conversation exists, both parties can use it.
  if (conversationInitiatedBy) {
    const startedByRequester = sameId(conversationInitiatedBy, connection.requester);
    const startedByRecipient = sameId(conversationInitiatedBy, connection.recipient);
    if ((!recipientPrivateAccount && startedByRequester) || (recipientPrivateAccount && startedByRecipient)) {
      return { allowed: true, mode: 'existing-permitted-conversation' };
    }
  }
  return messageDenied(recipientPrivateAccount
    ? 'This private account must connect back or message you first.'
    : 'Connect with this member before messaging.');
};

const findConnection = (firstId, secondId) => Connection.findOne({
  $or: [
    { requester: firstId, recipient: secondId },
    { requester: secondId, recipient: firstId }
  ]
}).select('requester recipient status').lean();

const getMessagePermission = async ({ initiatorId, peerId, conversation = null }) => {
  const [peer, initiator, connection] = await Promise.all([
    User.findById(peerId).select('privateAccount +blockedUsers').lean(),
    User.findById(initiatorId).select('+blockedUsers').lean(),
    findConnection(initiatorId, peerId)
  ]);
  if (!peer || !initiator) return messageDenied('Member not found.');
  if ((peer.blockedUsers || []).some((id) => sameId(id, initiatorId)) ||
      (initiator.blockedUsers || []).some((id) => sameId(id, peerId))) {
    return messageDenied('Messaging is unavailable for this member.');
  }
  return evaluateDirectMessagePermission({
    connection,
    initiatorId,
    peerId,
    recipientPrivateAccount: connection && sameId(connection.recipient, peerId)
      ? Boolean(peer.privateAccount)
      : Boolean(initiator.privateAccount),
    conversationInitiatedBy: conversation?.initiatedBy || null
  });
};

module.exports = { evaluateDirectMessagePermission, getMessagePermission, findConnection };
