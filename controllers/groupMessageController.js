const mongoose = require('mongoose');
const fs = require('fs/promises');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const { processUploadedMedia, deleteUploadedMedia } = require('../middleware/uploadMiddleware');
const { normalizeReaction, toggleReaction } = require('../utils/messageReactions');

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const PAGE_SIZE = 50;

const authorizedGroup = async (groupId, userId) => {
  if (!mongoose.isValidObjectId(groupId)) return null;
  return Group.findOne({ _id: groupId, 'members.user': userId }).select('_id members');
};

const requireGroupMember = async (req, res, next) => {
  try {
    const group = await authorizedGroup(req.params.id, req.user._id);
    if (!group) return fail(res, 404, 'Group not found or you are no longer a member.');
    req.authorizedGroup = group;
    return next();
  } catch (error) { return next(error); }
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

    let query = { group: group._id, hiddenFor: { $ne: req.user._id } };
    let descending = true;
    const anchorId = before || after;
    if (anchorId) {
      if (!mongoose.isValidObjectId(anchorId)) return fail(res, 400, 'Invalid message cursor.');
      const anchor = await GroupMessage.findOne({ _id: anchorId, group: group._id }).select('_id createdAt').lean();
      if (!anchor) return fail(res, 404, 'Message cursor not found.');
      query = {
        group: group._id,
        hiddenFor: { $ne: req.user._id },
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
    if (!before && !after) {
      await Group.updateOne(
        { _id: group._id, 'members.user': req.user._id },
        { $set: { 'members.$.lastReadAt': new Date() } }
      );
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, messages, hasMore: before ? messages.length === limit : undefined });
  } catch (error) { next(error); }
};

const sendMessage = async (req, res, next) => {
  let media;
  try {
    const group = req.authorizedGroup || await authorizedGroup(req.params.id, req.user._id);
    if (!group) return fail(res, 404, 'Group not found or you are no longer a member.');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const clientMessageId = typeof req.body?.clientMessageId === 'string' ? req.body.clientMessageId : undefined;
    if ((!text && !req.file) || text.length > 5000) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
      return fail(res, 400, 'Add a message or an image. Text can contain up to 5000 characters.');
    }
    if (clientMessageId && !/^[\w-]{8,80}$/.test(clientMessageId)) {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
      return fail(res, 400, 'Invalid message submission identifier.');
    }

    if (req.file) media = await processUploadedMedia(req.file, req, 'group-messages');

    let message;
    try {
      message = await GroupMessage.create({ group: group._id, sender: req.user._id, text, imageUrl: media?.url || '', imagePublicId: media?.publicId || '', clientMessageId });
    } catch (error) {
      if (error.code !== 11000 || !clientMessageId) throw error;
      if (media) await deleteUploadedMedia({ publicId: media.publicId, url: media.url }).catch(() => {});
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
  } catch (error) {
    if (media) await deleteUploadedMedia({ publicId: media.publicId, url: media.url }).catch(() => {});
    if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
};

const updateMessage = async (req, res, next) => {
  try {
    const group = await authorizedGroup(req.params.id, req.user._id);
    if (!group || !mongoose.isValidObjectId(req.params.messageId)) return fail(res, 404, 'Message not found.');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 5000) return fail(res, 400, 'Edited messages must contain 1–5000 characters.');
    const message = await GroupMessage.findOne({ _id: req.params.messageId, group: group._id, sender: req.user._id, deletedForEveryone: { $ne: true } });
    if (!message) return fail(res, 404, 'Only your own active messages can be edited.');
    message.text = text;
    message.editedAt = new Date();
    await message.save();
    await Group.updateOne({ _id: group._id, lastMessage: message._id }, { $set: { lastMessageAt: message.updatedAt } });
    await message.populate('sender', 'name profilePicture');
    res.json({ success: true, message });
  } catch (error) { next(error); }
};

const deleteMessage = async (req, res, next) => {
  try {
    const group = await authorizedGroup(req.params.id, req.user._id);
    const scope = req.query.scope || req.body?.scope;
    if (!group || !mongoose.isValidObjectId(req.params.messageId)) return fail(res, 404, 'Message not found.');
    if (!['me', 'everyone'].includes(scope)) return fail(res, 400, 'Choose whether to delete this message for you or everyone.');
    const message = await GroupMessage.findOne({ _id: req.params.messageId, group: group._id, hiddenFor: { $ne: req.user._id } });
    if (!message) return fail(res, 404, 'Message not found.');
    if (scope === 'everyone' && String(message.sender) !== String(req.user._id)) return fail(res, 403, 'You can delete for everyone only a message you sent.');
    if (scope === 'me') {
      await GroupMessage.updateOne({ _id: message._id }, { $addToSet: { hiddenFor: req.user._id } });
      return res.json({ success: true, scope, deletedMessageId: message._id });
    }
    const oldMedia = { publicId: message.imagePublicId, url: message.imageUrl };
    message.text = '';
    message.imageUrl = '';
    message.imagePublicId = '';
    message.deletedForEveryone = true;
    message.editedAt = null;
    await message.save();
    if (oldMedia.url || oldMedia.publicId) await deleteUploadedMedia(oldMedia).catch(() => {});
    await message.populate('sender', 'name profilePicture');
    res.json({ success: true, scope, message });
  } catch (error) { next(error); }
};

const toggleMessageReaction = async (req, res, next) => {
  try {
    const group = req.authorizedGroup || await authorizedGroup(req.params.id, req.user._id);
    if (!group || !mongoose.isValidObjectId(req.params.messageId)) return fail(res, 404, 'Message not found.');
    const emoji = normalizeReaction(req.body?.emoji);
    if (!emoji) return fail(res, 400, 'Choose one of the supported message reactions.');
    const message = await GroupMessage.findOne({ _id: req.params.messageId, group: group._id, hiddenFor: { $ne: req.user._id }, deletedForEveryone: { $ne: true } });
    if (!message) return fail(res, 404, 'Message not found.');
    toggleReaction(message, req.user._id, emoji);
    await message.save();
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, reactions: message.reactions });
  } catch (error) { next(error); }
};

module.exports = { getMessages, sendMessage, updateMessage, deleteMessage, toggleMessageReaction, requireGroupMember };
