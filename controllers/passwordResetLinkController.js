const User = require('../models/User');
const PasswordResetState = require('../models/PasswordResetState');
const { createResetToken, isResetToken, hashResetToken } = require('../utils/passwordResetSecurity');
const { consumeLimitSafe } = require('../utils/apiRateLimit');
const { sendResetEmail } = require('../services/passwordResetLinkEmail');

const GENERIC_MESSAGE = 'If that email exists, we sent a reset link.';
const TOKEN_TTL_MS = 30 * 60 * 1000;
const pepper = () => typeof process.env.PASSWORD_RESET_PEPPER === 'string' ? process.env.PASSWORD_RESET_PEPPER : '';
const digest = (token) => hashResetToken(token, pepper());
const genericResponse = (res) => res.status(200).json({ success: true, message: GENERIC_MESSAGE });

const buildResetLink = () => {
  const configuredClientUrl = typeof process.env.CLIENT_URL === 'string' ? process.env.CLIENT_URL.trim() : '';
  if (!configuredClientUrl) throw new Error('CLIENT_URL is not configured.');
  const clientUrl = new URL(configuredClientUrl);
  if (!['http:', 'https:'].includes(clientUrl.protocol) || clientUrl.username || clientUrl.password) {
    throw new Error('CLIENT_URL must be a valid HTTP(S) origin.');
  }
  const resetUrl = new URL('/reset-password', clientUrl.origin);
  return resetUrl;
};

const forgotPassword = async (req, res, next) => {
  try {
    const generic = () => genericResponse(res);
    if (typeof req.body.website === 'string' && req.body.website.trim()) return generic();

    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return generic();

    if (!process.env.PASSWORD_RESET_PEPPER || !process.env.BREVO_API_KEY || !process.env.SENDER_EMAIL) {
      return res.status(503).json({ success: false, message: 'Password recovery is temporarily unavailable.' });
    }

    const allowed = await consumeLimitSafe({
      key: `forgot-password:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
      windowMs: 60 * 60 * 1000,
      max: 20
    });
    if (!allowed) return generic();

    const user = await User.findOne({ email }).select('_id email');
    if (!user) return generic();

    const token = createResetToken();
    const tokenHash = digest(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await PasswordResetState.findOneAndUpdate(
      { user: user._id },
      { $set: {
        resetTokenHash: tokenHash,
        resetTokenExpiresAt: expiresAt,
        codeHash: '',
        codeExpiresAt: null,
        verificationAttempts: 0,
        consumedAt: null
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      const resetUrl = buildResetLink();
      resetUrl.searchParams.set('token', token);
      await sendResetEmail(user.email, resetUrl.toString());
    } catch (mailError) {
      await PasswordResetState.updateOne(
        { user: user._id, resetTokenHash: tokenHash },
        { $set: { resetTokenHash: '', resetTokenExpiresAt: null, consumedAt: new Date() } }
      );
      // Log only a category; never log the recipient, token, link, API key, or provider body.
      console.warn('[Password Reset Link] Email delivery failed:', mailError?.category || 'delivery_error');
      // Keep the same response for existing and unknown addresses to prevent account enumeration.
    }

    return generic();
  } catch (error) {
    next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    if (typeof req.body.website === 'string' && req.body.website.trim()) {
      return res.status(400).json({ success: false, message: 'The reset link is invalid or expired.' });
    }

    const { token, newPassword, confirmPassword } = req.body;
    if (!isResetToken(token)) {
      return res.status(400).json({ success: false, message: 'The reset link is invalid or expired.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Password must be between 8 and 128 characters.' });
    }
    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
    if (!process.env.PASSWORD_RESET_PEPPER) {
      return res.status(503).json({ success: false, message: 'Password recovery is temporarily unavailable.' });
    }

    const allowed = await consumeLimitSafe({
      key: `reset-password:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
      windowMs: 60 * 60 * 1000,
      max: 100
    });
    if (!allowed) {
      return res.status(429).json({ success: false, message: 'Too many reset attempts. Try again later.' });
    }

    const now = new Date();
    const state = await PasswordResetState.findOneAndUpdate(
      { resetTokenHash: digest(token), resetTokenExpiresAt: { $gt: now }, consumedAt: null },
      { $set: {
        resetTokenHash: '',
        resetTokenExpiresAt: null,
        codeHash: '',
        codeExpiresAt: null,
        consumedAt: now
      } },
      { new: true }
    );
    if (!state) {
      return res.status(400).json({ success: false, message: 'The reset link is invalid or expired.' });
    }

    const user = await User.findById(state.user).select('+password');
    if (!user) {
      return res.status(400).json({ success: false, message: 'The reset link is invalid or expired.' });
    }

    // UserSchema's pre-save hook hashes this plaintext password with bcrypt.
    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return res.status(200).json({ success: true, message: 'Password reset successfully. Please sign in with your new password.' });
  } catch (error) {
    next(error);
  }
};

module.exports = { forgotPassword, resetPassword, buildResetLink };
