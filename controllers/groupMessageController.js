const mongoose = require('mongoose');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const PAGE_SIZE = 50;

const authorizedGroup = async (groupId, userId) => {
  if (!mongoose.isValidObjectId(groupId)) return null;
  return Group.findOne({ _id: groupId, 'members.user': userId }).select('_id members');
};

const getMessages = async (req, res, next) => {
  try {
    const group = await authorizedGroup(req.params.id, req.user._id);
    if (!group) return fail(res, 404, 'Group not found or you are no longer a member.');

    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, PAGE_SIZE)) : PAGE_SIZE;
    const before = req.query.before;
    const after = req.query.after;
    if (before && after) return fail(res, 400, 'Choose either an older-message cursor or an updates cursor.');

    let query = { group: group._id };
    let descending = true;
    const anchorId = before || after;
    if (anchorId) {
      if (!mongoose.isValidObjectId(anchorId)) return fail(res, 400, 'Invalid message cursor.');
      const anchor = await GroupMessage.findOne({ _id: anchorId, group: group._id }).select('_id createdAt').lean();
      if (!anchor) return fail(res, 404, 'Message cursor not found.');
      query = {
        group: group._id,
        $or: before
          ? [{ createdAt: { $lt: anchor.createdAt } }, { createdAt: anchor.createdAt, _id: { $lt: anchor._id } }]
          : [{ createdAt: { $gt: anchor.createdAt } }, { createdAt: anchor.createdAt, _id: { $gt: anchor._id } }]
      };
      descending = Boolean(before);
    }

    let messages = await GroupMessage.find(query)
      .sort(descending ? { createdAt: -1, _id: -1 } : { createdAt: 1, _id: 1 })
      .limit(limit)
      .populate('sender', 'name profilePicture')
      .lean();
    if (descending) messages = messages.reverse();
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, messages, hasMore: before ? messages.length === limit : undefined });
  } catch (error) { next(error); }
};

const sendMessage = async (req, res, next) => {
  try {
    const group = await authorizedGroup(req.params.id, req.user._id);
    if (!group) return fail(res, 404, 'Group not found or you are no longer a member.');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const clientMessageId = typeof req.body?.clientMessageId === 'string' ? req.body.clientMessageId : undefined;
    if (!text || text.length > 5000) return fail(res, 400, 'Messages must contain 1–5000 characters.');
    if (clientMessageId && !/^[\w-]{8,80}$/.test(clientMessageId)) return fail(res, 400, 'Invalid message submission identifier.');

    let message;
    try {
      message = await GroupMessage.create({ group: group._id, sender: req.user._id, text, clientMessageId });
    } catch (error) {
      if (error.code !== 11000 || !clientMessageId) throw error;
      message = await GroupMessage.findOne({ group: group._id, sender: req.user._id, clientMessageId });
      if (!message) throw error;
      await Group.updateOne(
        { _id: group._id, 'members.user': req.user._id },
        { $set: { lastMessage: message._id, lastMessageAt: message.createdAt } }
      );
      await message.populate('sender', 'name profilePicture');
      return res.status(200).json({ success: true, message, duplicate: true });
    }

    await Group.updateOne(
      { _id: group._id, 'members.user': req.user._id },
      { $set: { lastMessage: message._id, lastMessageAt: message.createdAt } }
    );
    await message.populate('sender', 'name profilePicture');
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json({ success: true, message });
  } catch (error) { next(error); }
};

module.exports = { getMessages, sendMessage };
