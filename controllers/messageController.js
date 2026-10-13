const mongoose = require('mongoose');
const Connection = require('../models/Connection');
const Conversation = require('../models/Conversation');
const DirectMessage = require('../models/DirectMessage');
const User = require('../models/User');
const { isAcceptedPublicKeyPair } = require('../utils/publicEncryptionKeys');
const { isValidEncryptedKeyBackup } = require('../utils/encryptedKeyBackup');
const { normalizeDirectMessagePayload } = require('../utils/directMessagePayload');
const { normalizeReaction, toggleReaction } = require('../utils/messageReactions');
const { processUploadedMedia, deleteUploadedMedia } = require('../middleware/uploadMiddleware');
const fs = require('fs/promises');

const hasAcceptedConnection = async (userId, peerId) => Boolean(await Connection.exists({
  status: 'accepted',
  $or: [
    { requester: userId, recipient: peerId },
    { requester: peerId, recipient: userId }
  ]
}));

const isParticipant = (conversation, userId) => conversation.participants.some(
  (participant) => participant._id?.toString() === userId.toString() || participant.toString() === userId.toString()
);

const getAuthorizedConversation = async (conversationId, userId) => {
  if (!mongoose.isValidObjectId(conversationId)) return null;
  const conversation = await Conversation.findOne({ _id: conversationId, participants: userId });
  if (!conversation) return null;
  const peerId = conversation.participants.find((participant) => participant.toString() !== userId.toString());
  if (!peerId || !(await hasAcceptedConnection(userId, peerId))) return null;
  return { conversation, peerId };
};

const requireConversationParticipant = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized) return res.status(404).json({ success: false, message: 'Conversation not found or no longer available.' });
    req.authorizedConversation = authorized;
    return next();
  } catch (error) { return next(error); }
};

const getContacts = async (req, res, next) => {
  try {
    const accepted = await Connection.find({
      status: 'accepted',
      $or: [{ requester: req.user._id }, { recipient: req.user._id }]
    }).select('requester recipient').lean();

    const ids = accepted.map(({ requester, recipient }) => (
      requester.toString() === req.user._id.toString() ? recipient : requester
    ));
    const contacts = await User.find({ _id: { $in: ids } })
      .select('name headline profilePicture isVerifiedAccount verificationBadgeColor +encryptionPublicKey +encryptionSigningPublicKey encryptionKeyVersion')
      .lean();

    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, contacts });
  } catch (error) { next(error); }
};

const getOwnKey = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+encryptionPublicKey +encryptionSigningPublicKey encryptionKeyVersion');
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, publicKey: user?.encryptionPublicKey || '', signingPublicKey: user?.encryptionSigningPublicKey || '', keyVersion: user?.encryptionKeyVersion || 0 });
  } catch (error) { next(error); }
};

const getOwnKeyBackups = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+encryptionKeyBackups').lean();
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, backups: (user?.encryptionKeyBackups || []).map((backup) => ({
      _id: backup._id,
      formatVersion: backup.formatVersion,
      keyVersion: backup.keyVersion,
      publicKeyFingerprint: backup.publicKeyFingerprint,
      kdf: backup.kdf,
      iterations: backup.iterations,
      cipher: backup.cipher,
      salt: backup.salt,
      iv: backup.iv,
      ciphertext: backup.ciphertext,
      createdAt: backup.createdAt
    })) });
  } catch (error) { next(error); }
};

const saveOwnKeyBackup = async (req, res, next) => {
  try {
    const backup = req.body || {};
    const user = await User.findById(req.user._id).select('+encryptionPublicKey +encryptionSigningPublicKey +encryptionKeyBackups encryptionKeyVersion');
    if (!user?.encryptionPublicKey || !user?.encryptionSigningPublicKey) {
      return res.status(409).json({ success: false, message: 'Set up encrypted messaging on this account before creating a recovery backup.' });
    }
    if (user.encryptionKeyBackups.length >= 5) {
      return res.status(409).json({ success: false, message: 'This account already has five encrypted recovery backups. Keep them safe and remove none from the original device.' });
    }

    if (!isValidEncryptedKeyBackup(backup, {
      keyVersion: user.encryptionKeyVersion,
      publicKey: user.encryptionPublicKey,
      signingPublicKey: user.encryptionSigningPublicKey
    })) return res.status(400).json({ success: false, message: 'Invalid encrypted recovery backup.' });

    user.encryptionKeyBackups.push({
      formatVersion: backup.formatVersion,
      keyVersion: backup.keyVersion,
      publicKeyFingerprint: backup.publicKeyFingerprint,
      kdf: backup.kdf,
      iterations: backup.iterations,
      cipher: backup.cipher,
      salt: backup.salt,
      iv: backup.iv,
      ciphertext: backup.ciphertext
    });
    await user.save();
    res.set('Cache-Control', 'private, no-store');
    res.status(201).json({ success: true, backupCount: user.encryptionKeyBackups.length });
  } catch (error) { next(error); }
};

const saveOwnKey = async (req, res, next) => {
  try {
    const { publicKey, signingPublicKey } = req.body;
    if (typeof publicKey !== 'string' || publicKey.length > 4096 || typeof signingPublicKey !== 'string' || signingPublicKey.length > 4096) {
      return res.status(400).json({ success: false, message: 'Invalid public encryption key.' });
    }
    let parsedEncryptionKey;
    let parsedSigningKey;
    try {
      parsedEncryptionKey = JSON.parse(publicKey);
      parsedSigningKey = JSON.parse(signingPublicKey);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid public encryption key.' });
    }
    if (!isAcceptedPublicKeyPair(parsedEncryptionKey, parsedSigningKey)) {
      return res.status(400).json({ success: false, message: 'Only public RSA-OAEP and ECDSA P-256 keys are accepted.' });
    }

    const user = await User.findById(req.user._id).select('+encryptionPublicKey +encryptionSigningPublicKey encryptionKeyVersion');
    if ((user.encryptionPublicKey && user.encryptionPublicKey !== publicKey) ||
        (user.encryptionSigningPublicKey && user.encryptionSigningPublicKey !== signingPublicKey)) {
      return res.status(409).json({
        success: false,
        keyConflict: true,
        message: 'An encryption key is already registered. Replacing it can make existing messages unreadable.'
      });
    }
    if (!user.encryptionPublicKey || !user.encryptionSigningPublicKey) {
      user.encryptionPublicKey = publicKey;
      user.encryptionSigningPublicKey = signingPublicKey;
      user.encryptionKeyVersion += 1;
      await user.save();
    }
    res.json({ success: true, publicKey: user.encryptionPublicKey, signingPublicKey: user.encryptionSigningPublicKey, keyVersion: user.encryptionKeyVersion });
  } catch (error) { next(error); }
};

const listConversations = async (req, res, next) => {
  try {
    const conversations = await Conversation.find({ participants: req.user._id })
      .sort({ lastMessageAt: -1 })
      .populate('participants', 'name headline profilePicture isVerifiedAccount verificationBadgeColor');
    const conversationsWithPeers = conversations.map((conversation) => ({
      conversation,
      peer: conversation.participants.find((participant) => participant._id.toString() !== req.user._id.toString())
    })).filter(({ peer }) => Boolean(peer));
    const peerIds = conversationsWithPeers.map(({ peer }) => peer._id);
    const acceptedConnections = peerIds.length ? await Connection.find({
      status: 'accepted',
      $or: [
        { requester: req.user._id, recipient: { $in: peerIds } },
        { requester: { $in: peerIds }, recipient: req.user._id }
      ]
    }).select('requester recipient').lean() : [];
    const acceptedPeerIds = new Set(acceptedConnections.map(({ requester, recipient }) => (
      requester.toString() === req.user._id.toString() ? recipient.toString() : requester.toString()
    )));
    const visibleConversations = conversationsWithPeers.filter(({ conversation, peer }) => (
      acceptedPeerIds.has(peer._id.toString()) &&
      !conversation.hiddenFor.some((userId) => userId.toString() === req.user._id.toString())
    ));
    const visibleConversationIds = visibleConversations.map(({ conversation }) => conversation._id);
    const latestMessages = visibleConversationIds.length ? await DirectMessage.aggregate([
      { $match: { conversation: { $in: visibleConversationIds }, hiddenFor: { $ne: req.user._id } } },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: '$conversation',
        lastMessage: { $first: { _id: '$_id', createdAt: '$createdAt', sender: '$sender', text: '$text', imageUrl: '$imageUrl', deletedForEveryone: '$deletedForEveryone' } },
        unreadCount: { $sum: { $cond: [
          { $and: [
            { $ne: ['$sender', req.user._id] },
            { $not: [{ $in: [req.user._id, { $ifNull: ['$readBy', []] }] }] }
          ] },
          1,
          0
        ] } }
      } }
    ]) : [];
    const latestByConversation = new Map(latestMessages.map(({ _id, lastMessage, unreadCount }) => (
      [_id.toString(), { lastMessage, unreadCount }]
    )));
    const visible = visibleConversations.map(({ conversation, peer }) => ({
      _id: conversation._id,
      peer,
      displayName: conversation.displayNames.find(({ user }) => user.toString() === req.user._id.toString())?.name || '',
      lastMessageAt: conversation.lastMessageAt,
      lastMessage: (() => {
        const latest = latestByConversation.get(conversation._id.toString())?.lastMessage || null;
        return latest?.deletedForEveryone ? { ...latest, text: 'This message was deleted', imageUrl: '' } : latest;
      })(),
      unreadCount: latestByConversation.get(conversation._id.toString())?.unreadCount || 0
    }));
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, conversations: visible });
  } catch (error) { next(error); }
};

const openConversation = async (req, res, next) => {
  try {
    const peerId = req.params.userId;
    if (!mongoose.isValidObjectId(peerId) || peerId === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'Choose a valid connected person.' });
    }
    const [accepted, peer] = await Promise.all([
      hasAcceptedConnection(req.user._id, peerId),
      User.findById(peerId).select('name headline profilePicture isVerifiedAccount verificationBadgeColor +encryptionPublicKey +encryptionSigningPublicKey encryptionKeyVersion')
    ]);
    if (!accepted) {
      return res.status(403).json({ success: false, message: 'Messages are only available between accepted connections.' });
    }
    if (!peer) return res.status(404).json({ success: false, message: 'Connected account not found.' });

    const pairKey = [req.user._id.toString(), peer._id.toString()].sort().join(':');
    let conversation = await Conversation.findOne({ pairKey });
    if (!conversation) {
      try {
        conversation = await Conversation.create({ pairKey, participants: [req.user._id, peer._id] });
      } catch (error) {
        if (error.code !== 11000) throw error;
        conversation = await Conversation.findOne({ pairKey });
      }
    }
    if (conversation.hiddenFor.some((userId) => userId.toString() === req.user._id.toString())) {
      conversation.hiddenFor = conversation.hiddenFor.filter((userId) => userId.toString() !== req.user._id.toString());
      await conversation.save();
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, conversation: {
      _id: conversation._id,
      peer,
      displayName: conversation.displayNames.find(({ user }) => user.toString() === req.user._id.toString())?.name || ''
    } });
  } catch (error) { next(error); }
};

const deleteConversationForUser = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized) return res.status(404).json({ success: false, message: 'Conversation not found or no longer available.' });
    await Conversation.updateOne(
      { _id: authorized.conversation._id, participants: req.user._id },
      { $addToSet: { hiddenFor: req.user._id } }
    );
    res.json({ success: true });
  } catch (error) { next(error); }
};

const updateConversationName = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized) return res.status(404).json({ success: false, message: 'Conversation not found or no longer available.' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : null;
    if (name === null || name.length > 80) {
      return res.status(400).json({ success: false, message: 'Chat name must be 80 characters or fewer.' });
    }
    const conversation = authorized.conversation;
    conversation.displayNames = conversation.displayNames.filter(({ user }) => user.toString() !== req.user._id.toString());
    if (name) conversation.displayNames.push({ user: req.user._id, name });
    await conversation.save();
    res.json({ success: true, displayName: name });
  } catch (error) { next(error); }
};

const deleteMessage = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized || !mongoose.isValidObjectId(req.params.messageId)) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }
    const message = await DirectMessage.findOne({
      _id: req.params.messageId,
      conversation: authorized.conversation._id,
      hiddenFor: { $ne: req.user._id }
    });
    if (!message) return res.status(404).json({ success: false, message: 'Message not found.' });
    const scope = req.query.scope || req.body?.scope;
    if (!['me', 'everyone'].includes(scope)) return res.status(400).json({ success: false, message: 'Choose whether to delete this message for you or everyone.' });
    const isOwnMessage = String(message.sender) === String(req.user._id);
    if (scope === 'everyone' && !isOwnMessage) return res.status(403).json({ success: false, message: 'You can delete for everyone only a message you sent.' });
    if (scope === 'me') {
      await DirectMessage.updateOne({ _id: message._id }, { $addToSet: { hiddenFor: req.user._id } });
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

    const latestMessage = await DirectMessage.findOne({ conversation: authorized.conversation._id })
      .sort({ createdAt: -1 }).select('createdAt').lean();
    await Conversation.updateOne(
      { _id: authorized.conversation._id },
      { $set: { lastMessageAt: latestMessage?.createdAt || authorized.conversation.createdAt } }
    );
    res.json({ success: true, scope, message });
  } catch (error) { next(error); }
};

const updateMessage = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized || !mongoose.isValidObjectId(req.params.messageId)) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }
    const normalized = normalizeDirectMessagePayload(req.body);
    if (normalized.error || normalized.kind !== 'text') {
      return res.status(400).json({ success: false, message: normalized.error || 'Only text messages can be edited.' });
    }
    const message = await DirectMessage.findOne({
      _id: req.params.messageId,
      conversation: authorized.conversation._id,
      sender: req.user._id,
      deletedForEveryone: { $ne: true }
    });
    if (!message) return res.status(404).json({ success: false, message: 'Only your own messages can be edited.' });
    if (typeof message.text !== 'string') {
      return res.status(409).json({ success: false, message: 'Older encrypted messages can’t be edited.' });
    }
    message.text = normalized.text;
    message.editedAt = new Date();
    await message.save();
    res.json({ success: true, message });
  } catch (error) { next(error); }
};

const toggleMessageReaction = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized || !mongoose.isValidObjectId(req.params.messageId)) return res.status(404).json({ success: false, message: 'Message not found.' });
    const emoji = normalizeReaction(req.body?.emoji);
    if (!emoji) return res.status(400).json({ success: false, message: 'Choose one of the supported message reactions.' });
    const message = await DirectMessage.findOne({ _id: req.params.messageId, conversation: authorized.conversation._id, hiddenFor: { $ne: req.user._id }, deletedForEveryone: { $ne: true } });
    if (!message) return res.status(404).json({ success: false, message: 'Message not found.' });
    toggleReaction(message, req.user._id, emoji);
    await message.save();
    res.json({ success: true, reactions: message.reactions });
  } catch (error) { next(error); }
};

const getMessages = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized) return res.status(404).json({ success: false, message: 'Conversation not found or no longer available.' });

    const [messages] = await Promise.all([
      DirectMessage.find({ conversation: authorized.conversation._id, hiddenFor: { $ne: req.user._id } })
        .sort({ createdAt: -1 }).limit(200).lean(),
      DirectMessage.updateMany(
        { conversation: authorized.conversation._id, sender: { $ne: req.user._id }, readBy: { $ne: req.user._id } },
        { $addToSet: { readBy: req.user._id } }
      )
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, messages: messages.reverse() });
  } catch (error) { next(error); }
};

const sendMessage = async (req, res, next) => {
  let media;
  try {
    const authorized = req.authorizedConversation || await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized) return res.status(404).json({ success: false, message: 'Conversation not found or no longer available.' });

    if (req.file) {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (text.length > 5000) {
        if (req.file.path) await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ success: false, message: 'Captions can contain up to 5000 characters.' });
      }
      media = await processUploadedMedia(req.file, req, 'direct-messages');
      const messageTimestamp = new Date();
      const [message] = await Promise.all([
        DirectMessage.create({ conversation: authorized.conversation._id, sender: req.user._id, text, imageUrl: media.url, imagePublicId: media.publicId || '', readBy: [req.user._id], createdAt: messageTimestamp, updatedAt: messageTimestamp }),
        Conversation.updateOne({ _id: authorized.conversation._id }, { $max: { lastMessageAt: messageTimestamp }, $pull: { hiddenFor: { $in: authorized.conversation.participants } } })
      ]);
      res.set('Cache-Control', 'private, no-store');
      return res.status(201).json({ success: true, message });
    }

    const normalizedPayload = normalizeDirectMessagePayload(req.body);
    if (normalizedPayload.error) return res.status(400).json({ success: false, message: normalizedPayload.error });
    if (normalizedPayload.kind === 'text') {
      const messageTimestamp = new Date();
      const [message] = await Promise.all([
        DirectMessage.create({
          conversation: authorized.conversation._id,
          sender: req.user._id,
          text: normalizedPayload.text,
          readBy: [req.user._id],
          createdAt: messageTimestamp,
          updatedAt: messageTimestamp
        }),
        Conversation.updateOne(
          { _id: authorized.conversation._id },
          {
            $max: { lastMessageAt: messageTimestamp },
            $pull: { hiddenFor: { $in: authorized.conversation.participants } }
          }
        )
      ]);
      res.set('Cache-Control', 'private, no-store');
      return res.status(201).json({ success: true, message });
    }

    const participantIds = authorized.conversation.participants.map((id) => id.toString()).sort();
    if (typeof ciphertext !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(ciphertext) || ciphertext.length > 180000 ||
        typeof iv !== 'string' || !/^[A-Za-z0-9+/]{16}={0,2}$/.test(iv) ||
        !Array.isArray(wrappedKeys) || wrappedKeys.length !== 2 || typeof signature !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(signature) || signature.length > 256) {
      return res.status(400).json({ success: false, message: 'Invalid encrypted message payload.' });
    }

    const normalizedKeys = wrappedKeys.map((entry) => ({ user: String(entry.user), value: entry.value }));
    const wrappedIds = normalizedKeys.map(({ user }) => user).sort();
    if (participantIds.join(':') !== wrappedIds.join(':') || normalizedKeys.some(({ value }) => (
      typeof value !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(value) || value.length > 2048
    ))) {
      return res.status(400).json({ success: false, message: 'The message must be encrypted for both conversation participants.' });
    }

    const message = await DirectMessage.create({
      conversation: authorized.conversation._id,
      sender: req.user._id,
      ciphertext,
      iv,
      signature,
      wrappedKeys: normalizedKeys,
      readBy: [req.user._id]
    });
    authorized.conversation.lastMessageAt = message.createdAt;
    authorized.conversation.hiddenFor = [];
    await authorized.conversation.save();

    res.status(201).json({ success: true, message });
  } catch (error) {
    if (media) await deleteUploadedMedia({ publicId: media.publicId, url: media.url }).catch(() => {});
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
};

const syncLegacyMessages = async (req, res, next) => {
  try {
    const authorized = await getAuthorizedConversation(req.params.conversationId, req.user._id);
    if (!authorized) return res.status(404).json({ success: false, message: 'Conversation not found or no longer available.' });

    const entries = req.body?.messages;
    if (!Array.isArray(entries) || entries.length > 200) {
      return res.status(400).json({ success: false, message: 'Provide up to 200 messages to sync.' });
    }
    const updates = [];
    for (const entry of entries) {
      if (!mongoose.isValidObjectId(entry?.id)) {
        return res.status(400).json({ success: false, message: 'Invalid legacy message id.' });
      }
      const normalized = normalizeDirectMessagePayload({ text: entry.text });
      if (normalized.error) return res.status(400).json({ success: false, message: normalized.error });
      updates.push({
        updateOne: {
          filter: { _id: entry.id, conversation: authorized.conversation._id, text: { $exists: false } },
          update: { $set: { text: normalized.text } }
        }
      });
    }

    const result = updates.length ? await DirectMessage.bulkWrite(updates, { ordered: false }) : { modifiedCount: 0 };
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, synced: result.modifiedCount || 0 });
  } catch (error) { next(error); }
};

module.exports = { getContacts, getOwnKey, saveOwnKey, getOwnKeyBackups, saveOwnKeyBackup, listConversations, openConversation, deleteConversationForUser, updateConversationName, deleteMessage, updateMessage, toggleMessageReaction, getMessages, sendMessage, syncLegacyMessages, requireConversationParticipant };
