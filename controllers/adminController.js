const mongoose = require('mongoose');
const User = require('../models/User');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Connection = require('../models/Connection');
const Notification = require('../models/Notification');
const Conversation = require('../models/Conversation');
const DirectMessage = require('../models/DirectMessage');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const PasswordResetState = require('../models/PasswordResetState');
const SupportRequest = require('../models/SupportRequest');
const AdminAuditLog = require('../models/AdminAuditLog');
const { deleteUploadedMedia } = require('../middleware/uploadMiddleware');

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const safeReason = (reason) => typeof reason === 'string' ? reason.trim().slice(0, 1000) : '';

const overview = async (_req, res, next) => {
  try {
    const [totalUsers, activeBans, pendingRequests, unresolvedReports, openHelp] = await Promise.all([
      User.countDocuments({ moderationStatus: { $ne: 'deleted' } }),
      User.countDocuments({ $or: [{ moderationStatus: 'permanent_ban' }, { moderationStatus: 'temporary_ban', $or: [{ moderationExpiresAt: null }, { moderationExpiresAt: { $gt: new Date() } }] }] }),
      SupportRequest.countDocuments({ type: { $in: ['temporary_ban_appeal', 'permanent_ban_appeal', 'deleted_account_inquiry'] }, status: { $in: ['pending', 'under_review'] } }),
      SupportRequest.countDocuments({ type: 'report', status: { $in: ['pending', 'under_review'] } }),
      SupportRequest.countDocuments({ type: { $in: ['general_help', 'other'] }, status: { $in: ['pending', 'under_review'] } })
    ]);
    res.json({ success: true, overview: { totalUsers, activeBans, pendingRequests, unresolvedReports, openHelp } });
  } catch (error) { next(error); }
};

const listUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = {};
    const status = req.query.status;
    if (status === 'active') filter.$and = [{ $or: [{ moderationStatus: 'active' }, { moderationStatus: { $exists: false } }] }];
    else if (['temporary_ban', 'permanent_ban', 'deletion_pending', 'deleted'].includes(status)) filter.moderationStatus = status;
    else if (status === 'banned') filter.moderationStatus = { $in: ['temporary_ban', 'permanent_ban'] };
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 120) : '';
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const clauses = [{ name: { $regex: escaped, $options: 'i' } }, { email: { $regex: escaped, $options: 'i' } }];
      if (validId(search)) clauses.push({ _id: search });
      if (filter.$and) filter.$and.push({ $or: clauses });
      else filter.$or = clauses;
    }
    const [users, total] = await Promise.all([
      User.find(filter).select('name email profilePicture headline company jobTitle createdAt updatedAt moderationStatus moderationExpiresAt moderationReason').sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter)
    ]);
    res.json({ success: true, users: users.map((user) => ({ ...user, moderationStatus: user.moderationStatus || 'active' })), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
};

const userDetail = async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return fail(res, 400, 'Invalid user ID.');
    const user = await User.findById(req.params.id).select('-password +moderationStatus +moderationExpiresAt +moderationReason +moderationWarnings +hideActivity +blockedUsers +encryptionPublicKey +encryptionSigningPublicKey +encryptionKeyBackups').lean();
    if (!user) return fail(res, 404, 'User not found.');
    const [postCount, warnings] = await Promise.all([
      Post.countDocuments({ author: user._id }),
      User.findById(user._id).select('+moderationWarnings').lean().then((item) => (item?.moderationWarnings || []).map((warning) => ({ _id: warning._id, reason: warning.reason, issuedBy: warning.issuedBy, createdAt: warning.createdAt, acknowledgedAt: warning.acknowledgedAt })))
    ]);
    const profileSettings = { privateAccount: user.privateAccount, themePreference: user.themePreference, hideActivity: user.hideActivity };
    delete user.privateAccount; delete user.themePreference; delete user.hideActivity; delete user.blockedUsers;
    delete user.encryptionPublicKey; delete user.encryptionSigningPublicKey; delete user.encryptionKeyBackups;
    res.json({ success: true, user, profileSettings, postCount, warnings });
  } catch (error) { next(error); }
};

const userPosts = async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return fail(res, 400, 'Invalid user ID.');
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(30, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const [posts, total] = await Promise.all([
      Post.find({ author: req.params.id }).select('author content image mediaType videoUrl videoThumbnail tags createdAt updatedAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Post.countDocuments({ author: req.params.id })
    ]);
    res.json({ success: true, posts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
};

const findTarget = async (req, res) => {
  if (!validId(req.params.id)) { fail(res, 400, 'Invalid user ID.'); return null; }
  const user = await User.findById(req.params.id).select('+moderationStatus +moderationExpiresAt +moderationReason +moderationWarnings');
  if (!user || user.moderationStatus === 'deleted') { fail(res, 404, 'User not found.'); return null; }
  if (String(user._id) === String(req.user._id)) { fail(res, 400, 'You cannot moderate your own administrator account.'); return null; }
  return user;
};

const logAction = (req, user, action, reason, expiresAt = null, caseId = null, outcome = '') => AdminAuditLog.create({ targetUser: user?._id || null, admin: req.user._id, action, reason, expiresAt, caseId, outcome });

const sendSupportReply = async (email, message) => {
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.PASSWORD_RESET_FROM || 'vupriseofficial@gmail.com';
  if (!apiKey) return { sent: false, reason: 'Brevo email delivery is not configured on the server.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) return { sent: false, reason: 'The configured support sender address is invalid.' };
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: from, name: 'Vuprise Support' }, to: [{ email }], subject: 'Update to your Vuprise support request', textContent: message })
    });
    let body = {};
    try { body = await response.json(); } catch { /* A provider error is classified below. */ }
    if (!response.ok || typeof body.messageId !== 'string') {
      console.warn('[Support reply] Brevo rejected a support reply.');
      return { sent: false, reason: 'Brevo did not accept the email. The ticket update was saved, but no reply email was sent.' };
    }
    return { sent: true, reason: '' };
  } catch {
    console.warn('[Support reply] Brevo could not be reached.');
    return { sent: false, reason: 'Brevo could not be reached. The ticket update was saved, but no reply email was sent.' };
  }
};

const temporaryBan = async (req, res, next) => {
  try {
    const user = await findTarget(req, res); if (!user) return;
    if (user.moderationStatus === 'deletion_pending') return fail(res, 409, 'Account deletion is in progress. Resume deletion instead of changing moderation state.');
    const expiresAt = new Date(req.body?.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) return fail(res, 400, 'Choose a valid future ban expiration time.');
    const reason = safeReason(req.body?.reason);
    const currentStatus = user.moderationStatus || 'active';
    const result = await User.updateOne({ _id: user._id, $or: [{ moderationStatus: currentStatus }, ...(currentStatus === 'active' ? [{ moderationStatus: { $exists: false } }] : [])] }, { $set: { moderationStatus: 'temporary_ban', moderationExpiresAt: expiresAt, moderationReason: reason }, $inc: { tokenVersion: 1 } });
    if (!result.modifiedCount) return fail(res, 409, 'This account changed while you were reviewing it. Refresh and try again.');
    await logAction(req, user, 'temporary_ban', reason, expiresAt);
    res.json({ success: true, message: 'Temporary ban applied.', moderation: { status: user.moderationStatus, expiresAt, reason } });
  } catch (error) { next(error); }
};

const permanentBan = async (req, res, next) => {
  try {
    const user = await findTarget(req, res); if (!user) return;
    if (user.moderationStatus === 'deletion_pending') return fail(res, 409, 'Account deletion is in progress. Resume deletion instead of changing moderation state.');
    const reason = safeReason(req.body?.reason);
    const currentStatus = user.moderationStatus || 'active';
    const result = await User.updateOne({ _id: user._id, $or: [{ moderationStatus: currentStatus }, ...(currentStatus === 'active' ? [{ moderationStatus: { $exists: false } }] : [])] }, { $set: { moderationStatus: 'permanent_ban', moderationExpiresAt: null, moderationReason: reason }, $inc: { tokenVersion: 1 } });
    if (!result.modifiedCount) return fail(res, 409, 'This account changed while you were reviewing it. Refresh and try again.');
    await logAction(req, user, 'permanent_ban', reason);
    res.json({ success: true, message: 'Permanent ban applied.', moderation: { status: user.moderationStatus, reason } });
  } catch (error) { next(error); }
};

const liftBan = async (req, res, next) => {
  try {
    const user = await findTarget(req, res); if (!user) return;
    if (user.moderationStatus === 'deletion_pending') return fail(res, 409, 'Account deletion is in progress. Resume deletion instead of changing moderation state.');
    if (!['temporary_ban', 'permanent_ban'].includes(user.moderationStatus)) return fail(res, 409, 'This account does not have an active ban.');
    const priorStatus = user.moderationStatus;
    const result = await User.updateOne({ _id: user._id, moderationStatus: priorStatus }, { $set: { moderationStatus: 'active', moderationExpiresAt: null, moderationReason: '' }, $inc: { tokenVersion: 1 } });
    if (!result.modifiedCount) return fail(res, 409, 'This account changed while you were reviewing it. Refresh and try again.');
    await logAction(req, user, 'lift_ban', safeReason(req.body?.reason), null, null, `Lifted ${priorStatus}`);
    res.json({ success: true, message: 'Ban lifted. The user can sign in again.' });
  } catch (error) { next(error); }
};

const addWarning = async (req, res, next) => {
  try {
    const user = await findTarget(req, res); if (!user) return;
    if (user.moderationStatus === 'deletion_pending') return fail(res, 409, 'Account deletion is in progress. Resume deletion instead of changing moderation state.');
    const reason = safeReason(req.body?.reason);
    if (reason.length < 3) return fail(res, 400, 'Enter a warning reason.');
    const warning = { _id: new mongoose.Types.ObjectId(), reason, issuedBy: req.user._id, createdAt: new Date(), acknowledgedAt: null };
    await User.updateOne({ _id: user._id, moderationStatus: { $ne: 'deleted' } }, { $push: { moderationWarnings: warning } });
    await logAction(req, user, 'warning', reason);
    res.status(201).json({ success: true, warning: { _id: warning._id, reason, createdAt: warning.createdAt } });
  } catch (error) { next(error); }
};

const deleteUser = async (req, res, next) => {
  try {
    const user = await findTarget(req, res); if (!user) return;
    if (req.body?.confirm !== true) return fail(res, 400, 'Explicit confirmation is required.');
    const id = user._id;
    const previousStatus = user.moderationStatus || 'active';
    const started = await User.updateOne({ _id: id, $or: [{ moderationStatus: previousStatus }, ...(previousStatus === 'active' ? [{ moderationStatus: { $exists: false } }] : [])] }, { $set: { moderationStatus: 'deletion_pending', moderationExpiresAt: null, moderationReason: 'Account deletion in progress.' }, $inc: { tokenVersion: 1 } });
    if (!started.modifiedCount) return fail(res, 409, 'This account changed while deletion was starting. Refresh and try again.');
    const postCursor = Post.find({ author: id }).select('image imagePublicId videoUrl videoPublicId videoThumbnail videoSourceUrl videoSourcePublicId').lean().cursor();
    let mediaAttempted = 0; let mediaFailed = 0;
    for await (const post of postCursor) {
      for (const media of [
        { url: post.image, publicId: post.imagePublicId, resourceType: 'image' },
        { url: post.videoUrl, publicId: post.videoPublicId, resourceType: 'video' },
        { url: post.videoSourceUrl, publicId: post.videoSourcePublicId, resourceType: 'video' }
      ]) {
        if (!media.url && !media.publicId) continue;
        mediaAttempted += 1;
        try { await deleteUploadedMedia(media); } catch { mediaFailed += 1; }
      }
    }
    const authoredComments = Comment.find({ author: id }).select('_id post').lean().cursor();
    for await (const comment of authoredComments) {
      await Post.updateOne({ _id: comment.post }, { $pull: { comments: comment._id } });
    }
    const cleanMessageMedia = async (Model) => {
      const cursor = Model.find({ sender: id }).select('imageUrl imagePublicId').lean().cursor();
      for await (const message of cursor) {
        if (!message.imageUrl && !message.imagePublicId) continue;
        mediaAttempted += 1;
        try { await deleteUploadedMedia({ url: message.imageUrl, publicId: message.imagePublicId, resourceType: 'image' }); }
        catch { mediaFailed += 1; }
      }
    };
    await Promise.all([cleanMessageMedia(DirectMessage), cleanMessageMedia(GroupMessage)]);
    const ownedGroups = await Group.find({ owner: id }).select('_id members').lean();
    await Promise.all([
      Post.deleteMany({ author: id }), Comment.deleteMany({ author: id }),
      Connection.deleteMany({ $or: [{ requester: id }, { recipient: id }] }),
      Notification.deleteMany({ $or: [{ recipient: id }, { sender: id }] }),
      DirectMessage.deleteMany({ sender: id }),
      GroupMessage.deleteMany({ sender: id }),
      User.updateMany({ _id: { $ne: id } }, { $pull: { connections: id, followers: id, following: id, blockedUsers: id } }),
      Conversation.updateMany({ participants: id }, { $pull: { participants: id, hiddenFor: id, displayNames: { user: id } } }),
      Group.updateMany({ 'members.user': id }, { $pull: { members: { user: id }, invitations: { user: id } } }),
      PasswordResetState.deleteMany({ user: id }),
    ]);
    for (const group of ownedGroups) {
      const replacement = group.members.find((member) => String(member.user) !== String(id));
      if (replacement) await Group.updateOne({ _id: group._id }, { $set: { owner: replacement.user, 'members.$[member].role': 'owner' } }, { arrayFilters: [{ 'member.user': replacement.user }] });
      else {
        await GroupMessage.deleteMany({ group: group._id });
        await Group.deleteOne({ _id: group._id });
      }
    }
    user.name = 'Deleted user'; user.email = `deleted-${id}@deleted.invalid`; user.password = `deleted-${new mongoose.Types.ObjectId().toString()}-${Date.now()}`;
    user.headline = ''; user.bio = ''; user.location = ''; user.locationCountry = ''; user.locationRegion = ''; user.website = ''; user.company = ''; user.jobTitle = '';
    user.profilePicture = ''; user.coverImage = ''; user.skills = []; user.education = []; user.experience = [];
    user.connections = []; user.followers = []; user.following = []; user.blockedUsers = [];
    user.moderationStatus = 'deleted'; user.moderationExpiresAt = null; user.moderationReason = ''; user.moderationWarnings = []; user.tokenVersion += 1;
    await user.save();
    await logAction(req, { _id: id }, 'user_deleted', '', null, null, `Deleted account ${id}`);
    res.json({ success: true, message: 'Account deletion completed.', mediaCleanup: { attempted: mediaAttempted, failed: mediaFailed } });
  } catch (error) { next(error); }
};

const listInbox = (type) => async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { type: Array.isArray(type) ? { $in: type } : type };
    if (['pending', 'under_review', 'approved', 'rejected'].includes(req.query.status)) filter.status = req.query.status;
    const [requests, total] = await Promise.all([
      SupportRequest.find(filter).select('-__v').populate('user', 'name email moderationStatus moderationExpiresAt moderationReason').populate('reportedUser', 'name email moderationStatus moderationExpiresAt').populate('reportedPost', 'author content image mediaType videoUrl createdAt').populate('adminNotes.admin', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SupportRequest.countDocuments(filter)
    ]);
    res.json({ success: true, requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
};

const updateInboxItem = async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return fail(res, 400, 'Invalid request ID.');
    const item = await SupportRequest.findById(req.params.id);
    if (!item) return fail(res, 404, 'Request not found.');
    const { status, priority, note, resolution, outcome } = req.body || {};
    if (status !== undefined) {
      if (!['pending', 'under_review', 'approved', 'rejected'].includes(status)) return fail(res, 400, 'Invalid request status.');
      item.status = status;
    }
    if (priority !== undefined) {
      if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return fail(res, 400, 'Invalid priority.');
      item.priority = priority;
    }
    if (note !== undefined) {
      if (typeof note !== 'string' || note.trim().length < 2 || note.length > 3000) return fail(res, 400, 'Admin notes must be 2–3000 characters.');
      item.adminNotes.push({ text: note.trim(), admin: req.user._id });
    }
    const replyText = typeof resolution === 'string' ? resolution.trim() : '';
    const shouldSendReply = Boolean(replyText && (replyText !== item.resolution || !item.replySentAt));
    if (resolution !== undefined) {
      if (typeof resolution !== 'string' || resolution.length > 2000) return fail(res, 400, 'Resolution must be at most 2000 characters.');
      item.resolution = replyText;
    }
    item.resolvedAt = item.status === 'pending' || item.status === 'under_review' ? null : new Date();
    if (item.type.endsWith('_appeal') && item.status === 'approved') {
      if (!['lift_temporary_ban', 'lift_permanent_ban', 'reply_only'].includes(outcome)) return fail(res, 400, 'Select an explicit appeal outcome.');
      if (outcome.startsWith('lift_')) {
        if (!item.user) return fail(res, 409, 'This appeal is not linked to a restorable account.');
        const user = await User.findById(item.user).select('+moderationStatus +moderationExpiresAt +moderationReason');
        const expected = outcome === 'lift_temporary_ban' ? 'temporary_ban' : 'permanent_ban';
        if (!user || user.moderationStatus !== expected) return fail(res, 409, 'The linked account does not have the selected active ban.');
        const lifted = await User.updateOne({ _id: user._id, moderationStatus: expected }, { $set: { moderationStatus: 'active', moderationExpiresAt: null, moderationReason: '' }, $inc: { tokenVersion: 1 } });
        if (!lifted.modifiedCount) return fail(res, 409, 'This account changed while you were reviewing the appeal. Refresh and try again.');
        await logAction(req, user, 'lift_ban', '', null, item._id, `Approved appeal: lifted ${expected}`);
      }
      item.resolutionOutcome = outcome;
    }
    await item.save();
    const action = item.type === 'report' ? 'report_updated' : ['general_help', 'other'].includes(item.type) ? 'help_updated' : 'request_updated';
    await logAction(req, item.user ? { _id: item.user } : null, action, '', null, item._id, item.status);
    const reply = shouldSendReply ? await sendSupportReply(item.email, replyText) : null;
    if (reply?.sent) {
      item.replySentAt = new Date();
      await item.save();
    }
    res.json({ success: true, request: item, ...(reply && { reply }) });
  } catch (error) { next(error); }
};

module.exports = { overview, listUsers, userDetail, userPosts, temporaryBan, permanentBan, liftBan, addWarning, deleteUser, listRequests: listInbox(['temporary_ban_appeal', 'permanent_ban_appeal', 'deleted_account_inquiry']), listReports: listInbox('report'), listHelp: listInbox(['general_help', 'other']), updateInboxItem, sendSupportReply };
