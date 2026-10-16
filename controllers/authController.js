const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isVerifiedAccount } = require('../utils/verifiedAccount');
const { isAdminEmail } = require('../utils/adminAccess');
const { getAccountRestriction, getPendingWarnings } = require('../utils/accountModeration');
const { consumeLimitSafe } = require('../utils/apiRateLimit');

const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_PER_WINDOW = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const generateToken = (user) => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured before issuing a session.');
  return jwt.sign({ id: user._id, tokenVersion: user.tokenVersion || 0 }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d'
  });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword, company, jobTitle, location, accountType, schoolName, course, courseStartYear, website = '' } = req.body;

    // Honeypot field: real sign-up forms never fill a field hidden from users,
    // so a value here identifies an automated submission.
    if (typeof website === 'string' && website.trim()) {
      return res.status(400).json({ success: false, message: 'Registration could not be completed. Check the form and try again.' });
    }

    const registerAllowed = await consumeLimitSafe({
      key: `register:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
      windowMs: REGISTER_WINDOW_MS,
      max: REGISTER_MAX_PER_WINDOW
    });
    if (!registerAllowed) {
      return res.status(429).json({ success: false, message: 'Too many accounts were created from this connection. Please try again later.' });
    }

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide full name, email, and password.'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long.'
      });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match.'
      });
    }

    if (!['student', 'workplace'].includes(accountType)) {
      return res.status(400).json({ success: false, message: 'Choose Student or Workplace to continue.' });
    }

    const currentYear = new Date().getFullYear();
    if (accountType === 'student') {
      const year = Number(courseStartYear);
      if (typeof schoolName !== 'string' || !schoolName.trim() || schoolName.length > 120 ||
          typeof course !== 'string' || !course.trim() || course.length > 120 ||
          !Number.isInteger(year) || year < 1900 || year > currentYear + 10) {
        return res.status(400).json({ success: false, message: 'Provide a school or college, course, and valid start year.' });
      }
    } else if (typeof jobTitle !== 'string' || !jobTitle.trim() || jobTitle.length > 120 ||
        typeof company !== 'string' || !company.trim() || company.length > 120) {
      return res.status(400).json({ success: false, message: 'Provide your work role and company or organization.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'An account with this email address already exists. Please sign in instead.'
      });
    }

    // Default avatar gradient initials or placeholder
    const defaultAvatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=4f46e5,6366f1,7c3aed`;

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      headline: (accountType === 'student'
        ? `Student at ${schoolName.trim()}`
        : `${jobTitle.trim()} at ${company.trim()}`).slice(0, 140),
      company: accountType === 'student' ? schoolName.trim() : company.trim(),
      jobTitle: accountType === 'student' ? 'Student' : jobTitle.trim(),
      accountType,
      ...(accountType === 'student' && {
        education: [{ school: schoolName.trim(), fieldOfStudy: course.trim(), startYear: String(courseStartYear) }]
      }),
      location: location || 'San Francisco, CA',
      profilePicture: defaultAvatar
    });

    const token = generateToken(user);

    // Return user without password
    const userObj = user.toObject();
    userObj.isVerifiedAccount = isVerifiedAccount(userObj);
    delete userObj.password;
    delete userObj.moderationStatus;
    delete userObj.moderationExpiresAt;
    delete userObj.moderationReason;
    delete userObj.moderationWarnings;
    userObj.isAdmin = isAdminEmail(user.email);

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Welcome to Vuprise!',
      token,
      user: userObj
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res, next) => {
  try {
    const { email, password, website = '' } = req.body;

    const invalidCredentials = {
      success: false,
      message: 'Invalid email or password. Please check your credentials and try again.'
    };

    // Honeypot field: automated submissions get the same response as a wrong
    // password so the trap is not revealed.
    if (typeof website === 'string' && website.trim()) {
      return res.status(401).json(invalidCredentials);
    }

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please enter your email and password.'
      });
    }

    // Failed attempts are counted per connection + email and are throttled
    // before the password comparison result can be used for guessing.
    const failedLoginAllowed = async () => consumeLimitSafe({
      key: `login:${req.ip || req.socket?.remoteAddress || 'unknown'}:${email.toLowerCase().trim()}`,
      windowMs: LOGIN_WINDOW_MS,
      max: LOGIN_MAX_FAILURES
    });

    // Check user exists with password field selected
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password +hideActivity +inactivityRemindersEnabled +moderationStatus +moderationExpiresAt +moderationReason +moderationWarnings');

    if (!user) {
      if (!(await failedLoginAllowed())) {
        return res.status(429).json({ success: false, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });
      }
      return res.status(401).json(invalidCredentials);
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      if (!(await failedLoginAllowed())) {
        return res.status(429).json({ success: false, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' });
      }
      return res.status(401).json(invalidCredentials);
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

    const token = generateToken(user);

    const userObj = user.toObject();
    userObj.isVerifiedAccount = isVerifiedAccount(userObj);
    delete userObj.password;
    delete userObj.moderationStatus;
    delete userObj.moderationExpiresAt;
    delete userObj.moderationReason;
    delete userObj.moderationWarnings;
    userObj.isAdmin = isAdminEmail(user.email);

    res.status(200).json({
      success: true,
      message: 'Signed in successfully.',
      token,
      user: userObj,
      pendingWarnings: getPendingWarnings(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+hideActivity +inactivityRemindersEnabled +moderationWarnings')
      .populate('connections', 'name headline profilePicture company jobTitle isVerifiedAccount verificationBadgeColor')
      .populate('followers', 'name headline profilePicture isVerifiedAccount verificationBadgeColor')
      .populate('following', 'name headline profilePicture isVerifiedAccount verificationBadgeColor');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    const safeUser = user.toObject();
    safeUser.isVerifiedAccount = isVerifiedAccount(safeUser);
    delete safeUser.moderationStatus;
    delete safeUser.moderationExpiresAt;
    delete safeUser.moderationReason;
    delete safeUser.moderationWarnings;
    safeUser.isAdmin = isAdminEmail(user.email);
    res.status(200).json({
      success: true,
      user: safeUser,
      pendingWarnings: getPendingWarnings(user)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update password
// @route   PUT /api/auth/updatepassword
// @access  Private
const updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both current and new password.'
      });
    }

    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({
        success: false,
        message: 'New password must be between 8 and 128 characters.'
      });
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'New passwords do not match.'
      });
    }

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.matchPassword(currentPassword);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect.'
      });
    }

    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    const token = generateToken(user);

    res.status(200).json({
      success: true,
      message: 'Password updated successfully.',
      token
    });
  } catch (error) {
    next(error);
  }
};

const acknowledgeWarning = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+moderationWarnings');
    const warning = user?.moderationWarnings.id(req.params.warningId);
    if (!warning) return res.status(404).json({ success: false, message: 'Warning not found.' });
    if (!warning.acknowledgedAt) warning.acknowledgedAt = new Date();
    await user.save();
    res.json({ success: true, warningId: warning._id, acknowledgedAt: warning.acknowledgedAt });
  } catch (error) { next(error); }
};

module.exports = {
  register,
  login,
  getMe,
  updatePassword,
  acknowledgeWarning
};
