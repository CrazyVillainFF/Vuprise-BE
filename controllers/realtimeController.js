const mongoose = require('mongoose');
const Connection = require('../models/Connection');
const Conversation = require('../models/Conversation');
const Group = require('../models/Group');
const User = require('../models/User');
const hub = require('../realtime/presenceHub');

const fail = (res, status, message) => res.status(status).json({ success: false, message });

exports.events = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+hideActivity name');
    if (!user) return fail(res, 401, 'Sign in to start a realtime session.');
  res.status(200);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const session = hub.createSession(user, res);
  const keepAlive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
  }, 20_000);
  keepAlive.unref?.();
  res.on('close', () => {
    clearInterval(keepAlive);
    if (hub.removeSession(session) && hub.getSessionCount(session.userId) === 0) {
      const lastSeenAt = new Date();
      User.updateOne({ _id: session.userId }, { $set: { lastSeenAt }, $unset: { inactivityReminderClaimedAt: 1 } }).then(() => hub.setLastSeen(session.userId, lastSeenAt)).catch(() => {});
    }
  });
  } catch (error) { next(error); }
};

exports.heartbeat = async (req, res, next) => {
  try {
  if (!hub.heartbeat(req.user._id, req.body.sessionId)) return fail(res, 401, 'Realtime session expired. Reconnect to continue.');
  if (hub.shouldPersistLastSeen(req.user._id)) {
    const lastSeenAt = new Date();
    await User.updateOne({ _id: req.user._id }, { $set: { lastSeenAt }, $unset: { inactivityReminderClaimedAt: 1 } });
    hub.setLastSeen(req.user._id, lastSeenAt);
  }
  res.json({ success: true, timestamp: Date.now() });
  } catch (error) { next(error); }
};

const getVisiblePresenceIds = async (viewerId, targetIds) => {
  const requested = targetIds.filter((id) => String(id) !== String(viewerId));
  if (!requested.length) return [];
  const [connections, conversations, groups] = await Promise.all([
    Connection.find({ status: 'accepted', $or: [{ requester: viewerId, recipient: { $in: requested } }, { recipient: viewerId, requester: { $in: requested } }] }).select('requester recipient').lean(),
    Conversation.find({ $and: [{ participants: viewerId }, { participants: { $in: requested } }], hiddenFor: { $ne: viewerId } }).select('participants').lean(),
    Group.find({ $and: [{ 'members.user': viewerId }, { 'members.user': { $in: requested } }] }).select('members.user').lean(),
  ]);
  const visible = new Set();
  for (const connection of connections) visible.add(String(String(connection.requester) === String(viewerId) ? connection.recipient : connection.requester));
  for (const conversation of conversations) for (const id of conversation.participants) if (String(id) !== String(viewerId)) visible.add(String(id));
  for (const group of groups) for (const member of group.members) if (String(member.user) !== String(viewerId)) visible.add(String(member.user));
  return requested.filter((id) => visible.has(String(id))).map(String);
};

exports.watchPresence = async (req, res, next) => {
  try {
    const { sessionId, userIds } = req.body;
    if (typeof sessionId !== 'string' || !Array.isArray(userIds) || userIds.length > 100 || userIds.some((id) => !mongoose.isValidObjectId(id))) {
      return fail(res, 400, 'Provide a valid realtime session and up to 100 user IDs.');
    }
    const allowed = await getVisiblePresenceIds(req.user._id, [...new Set(userIds.map(String))]);
    const preferences = await User.find({ _id: { $in: allowed } }).select('+hideActivity +lastSeenAt _id');
    for (const target of preferences) { hub.setHidden(target._id, target.hideActivity); hub.setLastSeen(target._id, target.lastSeenAt); }
    if (!hub.replaceWatches(req.user._id, sessionId, allowed)) return fail(res, 401, 'Realtime session expired. Reconnect to continue.');
    res.json({ success: true, watching: allowed.length });
  } catch (error) { next(error); }
};

exports.logout = async (req, res, next) => {
  try {
  const session = hub.getSession(req.body.sessionId);
  if (!session || session.userId !== String(req.user._id)) return fail(res, 404, 'Realtime session not found.');
  if (hub.removeSession(session) && hub.getSessionCount(session.userId) === 0) {
    const lastSeenAt = new Date();
    await User.updateOne({ _id: session.userId }, { $set: { lastSeenAt }, $unset: { inactivityReminderClaimedAt: 1 } });
    hub.setLastSeen(session.userId, lastSeenAt);
  }
  res.json({ success: true });
  } catch (error) { next(error); }
};

exports.typing = (scopeType) => async (req, res, next) => {
  try {
    const scopeId = String(req.params.id || '');
    if (!mongoose.isValidObjectId(scopeId)) return fail(res, 404, 'Conversation not found.');
    let recipients;
    if (scopeType === 'conversation') {
      const conversation = await Conversation.findOne({ _id: scopeId, participants: req.user._id, hiddenFor: { $ne: req.user._id } }).select('participants');
      if (!conversation) return fail(res, 404, 'Conversation not found or no longer available.');
      recipients = conversation.participants.filter((id) => String(id) !== String(req.user._id));
    } else {
      const group = await Group.findOne({ _id: scopeId, 'members.user': req.user._id }).select('members.user');
      if (!group) return fail(res, 404, 'Group not found or you are not a member.');
      recipients = group.members.map(({ user }) => user).filter((id) => String(id) !== String(req.user._id));
    }
    hub.setTyping({ scopeId, scopeType, senderId: req.user._id, senderName: req.user.name, recipients, active: req.body.active === true });
    res.status(204).end();
  } catch (error) { next(error); }
};
