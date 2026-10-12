const User = require('../models/User');
const SupportRequest = require('../models/SupportRequest');

const rateWindows = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function consumeRateLimit(key, now = Date.now()) {
  if (rateWindows.size > 10000) {
    for (const [storedKey, value] of rateWindows) {
      if (now - value.startedAt >= WINDOW_MS) rateWindows.delete(storedKey);
      if (rateWindows.size <= 8000) break;
    }
  }
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

const createRequest = async (req, res, next) => {
  try {
    const { type, email, subject, message, category = '', userId = '', reportedUser = '', reportedPost = '', evidenceUrls = [], website = '' } = req.body || {};
    if (website) return res.status(202).json({ success: true, message: 'Your request has been received.' });
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const validTypes = ['temporary_ban_appeal', 'permanent_ban_appeal', 'deleted_account_inquiry', 'general_help', 'report', 'other'];
    if (!validTypes.includes(type) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
      typeof subject !== 'string' || subject.trim().length < 3 || subject.trim().length > 160 ||
      typeof message !== 'string' || message.trim().length < 10 || message.trim().length > 5000 ||
      typeof category !== 'string' || category.length > 80 ||
      (userId && !/^[a-f\d]{24}$/i.test(userId)) || (reportedUser && !/^[a-f\d]{24}$/i.test(reportedUser)) ||
      (reportedPost && !/^[a-f\d]{24}$/i.test(reportedPost)) || !Array.isArray(evidenceUrls) || evidenceUrls.length > 5 ||
      evidenceUrls.some((value) => typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value))) {
      return res.status(400).json({ success: false, message: 'Check the request type, email, subject, and message, then try again.' });
    }

    const ipKey = `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const emailKey = `email:${normalizedEmail}`;
    if (!consumeRateLimit(ipKey) || !consumeRateLimit(emailKey)) {
      return res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
    }

    let associatedUser = null;
    const tokenUser = req.user;
    if (tokenUser && tokenUser.email === normalizedEmail) associatedUser = tokenUser._id;
    else if (typeof userId === 'string' && /^[a-f\d]{24}$/i.test(userId)) {
      const candidate = await User.findById(userId).select('email moderationStatus');
      if (candidate?.email === normalizedEmail) associatedUser = candidate._id;
    }

    const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
    if (type === 'report') {
      if (!validId(reportedUser) && !validId(reportedPost)) return res.status(400).json({ success: false, message: 'Choose the reported account or post.' });
      if (validId(reportedUser) && !(await User.exists({ _id: reportedUser, moderationStatus: { $ne: 'deleted' } }))) return res.status(404).json({ success: false, message: 'Reported account not found.' });
      if (validId(reportedPost) && !(await require('../models/Post').exists({ _id: reportedPost }))) return res.status(404).json({ success: false, message: 'Reported post not found.' });
    }
    const item = await SupportRequest.create({
      type, email: normalizedEmail, user: associatedUser,
      subject: subject.trim(), message: message.trim(), category: category.trim(),
      reportedUser: type === 'report' && validId(reportedUser) ? reportedUser : null,
      reportedPost: type === 'report' && validId(reportedPost) ? reportedPost : null,
      evidenceUrls: evidenceUrls.map((value) => value.trim()),
      status: 'pending', priority: 'normal'
    });
    return res.status(201).json({ success: true, message: 'Your request has been received.', requestId: item._id });
  } catch (error) { return next(error); }
};

module.exports = { createRequest, consumeRateLimit };
