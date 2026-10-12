const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isAdminEmail } = require('../utils/adminAccess');
const { getAccountRestriction } = require('../utils/accountModeration');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route. Please sign in.'
    });
  }

  try {
    if (!process.env.JWT_SECRET) throw new Error('Authentication is not configured.');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password +moderationStatus +moderationExpiresAt +moderationReason');

    if (!user || user.moderationStatus === 'deleted') {
      return res.status(401).json({
        success: false,
        message: 'The user belonging to this token no longer exists.'
      });
    }

    const restriction = await getAccountRestriction(user);
    if (restriction) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_RESTRICTED',
        restriction,
        message: restriction.status === 'temporary_ban' ? 'Your account is temporarily restricted.' : restriction.status === 'deletion_pending' ? 'Your account deletion is being completed.' : 'Your account is permanently restricted.'
      });
    }

    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: 'The user belonging to this token no longer exists.'
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Your session has expired. Please sign in again.'
      });
    }
    if (err.name !== 'JsonWebTokenError' && err.name !== 'NotBeforeError') return next(err);
    return res.status(401).json({
      success: false,
      message: 'Invalid authorization token.'
    });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
  }
  if (!isAdminEmail(req.user.email)) {
    return res.status(403).json({ success: false, message: 'Administrator access is required.' });
  }
  return next();
};

// Optional auth: populate req.user if token present, but do not block if guest
const optionalAuth = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next();
  }

  try {
    if (!process.env.JWT_SECRET) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (user && (decoded.tokenVersion ?? 0) === (user.tokenVersion || 0)) {
      req.user = user;
    }
  } catch (err) {
    // Ignore invalid optional tokens
  }
  next();
};

module.exports = { protect, optionalAuth, requireAdmin };
