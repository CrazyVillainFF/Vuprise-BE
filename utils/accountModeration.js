const getAccountRestriction = async (user, now = new Date()) => {
  if (user.moderationStatus === 'permanent_ban') {
    return { status: 'permanent_ban', reason: user.moderationReason || '' };
  }
  if (user.moderationStatus === 'deletion_pending') {
    return { status: 'deletion_pending', reason: 'Your account deletion is being completed.' };
  }
  if (user.moderationStatus !== 'temporary_ban') return null;

  const expiresAt = user.moderationExpiresAt ? new Date(user.moderationExpiresAt) : null;
  if (expiresAt && expiresAt <= now) {
    const User = require('../models/User');
    await User.updateOne(
      { _id: user._id, moderationStatus: 'temporary_ban', moderationExpiresAt: { $lte: now } },
      { $set: { moderationStatus: 'active', moderationExpiresAt: null, moderationReason: '' } }
    );
    user.moderationStatus = 'active';
    user.moderationExpiresAt = null;
    user.moderationReason = '';
    return null;
  }

  return { status: 'temporary_ban', expiresAt, reason: user.moderationReason || '' };
};

const getPendingWarnings = (user) => (user.moderationWarnings || [])
  .filter((warning) => !warning.acknowledgedAt)
  .map((warning) => ({ _id: warning._id, reason: warning.reason, createdAt: warning.createdAt }));

module.exports = { getAccountRestriction, getPendingWarnings };
