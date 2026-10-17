const User = require('../models/User');
const SupportRequest = require('../models/SupportRequest');
const { processUploadedFile } = require('../middleware/uploadMiddleware');
const { consumeLimit, consumeLimitSafe } = require('../utils/apiRateLimit');

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const removeTemporaryEvidence = async (files = []) => Promise.all(files.map((file) => require('fs').promises.unlink(file.path).catch(() => {})));

// Persisted per-key limits (see utils/apiRateLimit.js). Kept as a named export
// because existing tests and future routes share the same support window.
function consumeRateLimit(key) {
  return consumeLimit({ key, windowMs: WINDOW_MS, max: MAX_PER_WINDOW });
}

const createRequest = async (req, res, next) => {
  try {
    const { type, email, subject, message, category = '', userId = '', reportedUser = '', reportedPost = '', reportedComment = '', reportedMessage = '', reportedMessageScope = '', reportedThreadId = '', evidenceUrls = [], website = '' } = req.body || {};
    const evidenceFiles = req.files || [];
    if (website) { await removeTemporaryEvidence(evidenceFiles); return res.status(202).json({ success: true, message: 'Your request has been received.' }); }
    // Field-specific validation so the form can show an actionable error
    // instead of one generic message for every problem.
    const reject = async (fieldMessage) => {
      await removeTemporaryEvidence(evidenceFiles);
      return res.status(400).json({ success: false, message: fieldMessage });
    };
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const validTypes = ['temporary_ban_appeal', 'permanent_ban_appeal', 'deleted_account_inquiry', 'general_help', 'report', 'other'];
    if (!validTypes.includes(type)) return reject('Request type: please select a valid option.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return reject('Email: enter a valid email address.');
    if (typeof subject !== 'string' || subject.trim().length < 3) return reject('Subject: enter at least 3 characters.');
    if (subject.trim().length > 160) return reject('Subject: keep it under 160 characters.');
    if (typeof message !== 'string' || message.trim().length < 10) return reject('Message: enter at least 10 characters.');
    if (message.trim().length > 5000) return reject('Message: keep it under 5000 characters.');
    if (typeof category !== 'string' || category.length > 80) return reject('Category: keep it under 80 characters.');
    // The optional account user ID is a free-text hint (a name such as
    // "Archana" is fine). It is never trusted as identity proof: the link to an
    // account is only made when it is a real ObjectId that matches the
    // submitted email (see below), or by exact email match.
    if (typeof userId !== 'string' || userId.trim().length > 120) return reject('Account user ID: keep it under 120 characters.');
    const idFields = [[reportedUser, 'Reported user'], [reportedPost, 'Reported post'], [reportedComment, 'Reported comment'], [reportedMessage, 'Reported message'], [reportedThreadId, 'Reported conversation']];
    for (const [value, label] of idFields) {
      if (value && (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value))) return reject(`${label}: enter a valid ID.`);
    }
    if (reportedMessage && !['direct', 'group'].includes(reportedMessageScope)) return reject('Reported message: choose direct or group scope.');
    if (reportedMessage && !reportedThreadId) return reject('Reported message: include the conversation it belongs to.');
    if (!reportedMessage && (reportedMessageScope || reportedThreadId)) return reject('Reported conversation: select a reported message first.');
    if (!Array.isArray(evidenceUrls) || evidenceUrls.length + evidenceFiles.length > 5) return reject('Evidence: attach at most 5 files or links.');
    if (evidenceUrls.some((value) => typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value))) return reject('Evidence: links must be valid https URLs.');

    const ipKey = `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const emailKey = `email:${normalizedEmail}`;
    const [ipAllowed, emailAllowed] = await Promise.all([
      consumeLimitSafe({ key: ipKey, windowMs: WINDOW_MS, max: MAX_PER_WINDOW }),
      consumeLimitSafe({ key: emailKey, windowMs: WINDOW_MS, max: MAX_PER_WINDOW })
    ]);
    if (!ipAllowed || !emailAllowed) {
      await removeTemporaryEvidence(evidenceFiles);
      return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
    }

    // Double submissions (double-click, retry after a slow response) would
    // otherwise create duplicate tickets. The identical request is treated as
    // already received instead of being stored a second time.
    const duplicate = await SupportRequest.exists({
      email: normalizedEmail,
      type,
      subject: subject.trim(),
      message: message.trim(),
      createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) }
    });
    if (duplicate) {
      await removeTemporaryEvidence(evidenceFiles);
      return res.status(200).json({ success: true, message: 'Your request has been received.' });
    }

    let associatedUser = null;
    const tokenUser = req.user;
    if (tokenUser && String(tokenUser.email || '').toLowerCase() === normalizedEmail) associatedUser = tokenUser._id;
    else if (typeof userId === 'string' && /^[a-f\d]{24}$/i.test(userId)) {
      const candidate = await User.findById(userId).select('email moderationStatus');
      if (candidate && String(candidate.email || '').toLowerCase() === normalizedEmail) associatedUser = candidate._id;
    }
    // Appeals are often filed by restricted users who can no longer sign in, so
    // fall back to the exact account email. Without this link an administrator
    // cannot approve a ban lift later.
    if (!associatedUser) {
      const account = await User.findOne({ email: normalizedEmail }).select('_id').lean();
      if (account) associatedUser = account._id;
    }

    const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
    if (type === 'report') {
      if (!validId(reportedUser) && !validId(reportedPost) && !validId(reportedComment) && !validId(reportedMessage)) { await removeTemporaryEvidence(evidenceFiles); return res.status(400).json({ success: false, message: 'Choose the reported account, post, comment, or message.' }); }
      if (validId(reportedUser) && !(await User.exists({ _id: reportedUser, moderationStatus: { $ne: 'deleted' } }))) { await removeTemporaryEvidence(evidenceFiles); return res.status(404).json({ success: false, message: 'Reported account not found.' }); }
      if (validId(reportedPost) && !(await require('../models/Post').exists({ _id: reportedPost }))) { await removeTemporaryEvidence(evidenceFiles); return res.status(404).json({ success: false, message: 'Reported post not found.' }); }
      if (validId(reportedComment) && !(await require('../models/Comment').exists({ _id: reportedComment }))) { await removeTemporaryEvidence(evidenceFiles); return res.status(404).json({ success: false, message: 'Reported comment not found.' }); }
      if (validId(reportedMessage)) {
        if (!req.user || String(req.user.email).toLowerCase() !== normalizedEmail) { await removeTemporaryEvidence(evidenceFiles); return res.status(401).json({ success: false, message: 'Sign in with your account email to report a message.' }); }
        if (reportedMessageScope === 'direct') {
          const [conversation, targetMessage] = await Promise.all([
            require('../models/Conversation').exists({ _id: reportedThreadId, participants: req.user._id, hiddenFor: { $ne: req.user._id } }),
            require('../models/DirectMessage').exists({ _id: reportedMessage, conversation: reportedThreadId, hiddenFor: { $ne: req.user._id }, deletedForEveryone: { $ne: true } })
          ]);
          if (!conversation || !targetMessage) { await removeTemporaryEvidence(evidenceFiles); return res.status(404).json({ success: false, message: 'The reported message is not available.' }); }
        } else {
          const [group, targetMessage] = await Promise.all([
            require('../models/Group').exists({ _id: reportedThreadId, 'members.user': req.user._id }),
            require('../models/GroupMessage').exists({ _id: reportedMessage, group: reportedThreadId, hiddenFor: { $ne: req.user._id }, deletedForEveryone: { $ne: true } })
          ]);
          if (!group || !targetMessage) { await removeTemporaryEvidence(evidenceFiles); return res.status(404).json({ success: false, message: 'The reported message is not available.' }); }
        }
      }
    }
    const uploadedEvidenceUrls = await Promise.all(evidenceFiles.map((file) => processUploadedFile(file, req, 'support-evidence')));
    const item = await SupportRequest.create({
      type, email: normalizedEmail, user: associatedUser,
      subject: subject.trim(), message: message.trim(), category: category.trim(),
      reportedUser: type === 'report' && validId(reportedUser) ? reportedUser : null,
      reportedPost: type === 'report' && validId(reportedPost) ? reportedPost : null,
      reportedComment: type === 'report' && validId(reportedComment) ? reportedComment : null,
      reportedMessage: type === 'report' && validId(reportedMessage) ? reportedMessage : null,
      reportedMessageScope: type === 'report' && validId(reportedMessage) ? reportedMessageScope : undefined,
      reportedMessageModel: type === 'report' && validId(reportedMessage) ? (reportedMessageScope === 'direct' ? 'DirectMessage' : 'GroupMessage') : undefined,
      reportedThread: type === 'report' && validId(reportedMessage) ? reportedThreadId : null,
      reportedThreadModel: type === 'report' && validId(reportedMessage) ? (reportedMessageScope === 'direct' ? 'Conversation' : 'Group') : undefined,
      evidenceUrls: [...evidenceUrls.map((value) => value.trim()), ...uploadedEvidenceUrls],
      status: 'pending', priority: 'normal'
    });
    return res.status(201).json({ success: true, message: 'Your request has been received.', requestId: item._id });
  } catch (error) { return next(error); }
};

module.exports = { createRequest, consumeRateLimit };
