const User = require('../models/User');
const PasswordResetState = require('../models/PasswordResetState');
const PasswordResetCounter = require('../models/PasswordResetCounter');
const { createResetCode, hashResetToken } = require('../utils/passwordResetSecurity');
const { getBrevoConfig } = require('../services/brevoEmail');

const genericRequestMessage = 'If an account matches this email, a password reset code will be sent.';
const WINDOW_MS = 30 * 60 * 1000;
const COUNTER_TTL_MS = 48 * 60 * 60 * 1000;
const pepper = () => process.env.PASSWORD_RESET_PEPPER || '';
const digest = (value) => hashResetToken(value, pepper());
const ipKey = (ip) => `ip:${digest(ip || 'unknown')}`;
const userKey = (id) => `user:${digest(id.toString())}`;

const reserveCounter = async (key, limit, now = new Date()) => {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  await PasswordResetCounter.updateOne(
    { key },
    { $setOnInsert: { key, count: 0, windowStartedAt: now, expiresAt: new Date(now.getTime() + COUNTER_TTL_MS) } },
    { upsert: true }
  );

  return PasswordResetCounter.findOneAndUpdate(
    { key, $or: [{ windowStartedAt: { $lte: cutoff } }, { count: { $lt: limit } }] },
    [{ $set: {
      count: { $cond: [{ $lte: ['$windowStartedAt', cutoff] }, 1, { $add: ['$count', 1] }] },
      windowStartedAt: { $cond: [{ $lte: ['$windowStartedAt', cutoff] }, now, '$windowStartedAt'] },
      expiresAt: new Date(now.getTime() + COUNTER_TTL_MS)
    } }],
    { new: true }
  );
};

const releaseCounter = async (key, windowStartedAt) => {
  await PasswordResetCounter.updateOne(
    { key, windowStartedAt, count: { $gt: 0 } },
    { $inc: { count: -1 } }
  );
};

const getMailConfiguration = () => {
  const { apiKey, senderEmail, senderName } = getBrevoConfig();
  if (!apiKey) return { error: 'Brevo email delivery is not configured on the server.' };
  if (!/^(?:[^<>\r\n]+\s<)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+(?:>)?$/.test(senderEmail)) {
    return { error: 'The configured password-reset sender address is invalid.' };
  }

  return { apiKey, from: senderEmail, senderName };
};

const classifyBrevoError = (providerError) => {
  const detail = `${providerError?.name || ''} ${providerError?.message || ''} ${providerError?.status || ''} ${providerError?.code || ''}`.toLowerCase();
  if (/recipient|email.*not valid|contact.*not found|blocked|blacklist|not authorized.*email/.test(detail)) {
    return {
      category: 'recipient_not_permitted',
      message: 'Brevo rejected the recipient address. Check that the address is valid and permitted by your Brevo account. No email was sent.'
    };
  }
  if (/sender|\bfrom\b|domain.*verif|verif.*domain/.test(detail)) {
    return {
      category: 'sender_rejected',
      message: 'Brevo rejected the configured sender. Check BREVO_SENDER_EMAIL (or the PASSWORD_RESET_FROM fallback) and verify that sender in Brevo. No email was sent.'
    };
  }
  return {
    category: 'provider_rejected',
    message: 'Brevo could not accept the password-reset email. No email was sent; check the Brevo transactional email logs and try again.'
  };
};

const sendResetEmail = async (to, resetCode, mailConfig) => {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': mailConfig.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: mailConfig.from, name: mailConfig.senderName },
      to: [{ email: to }],
      subject: 'Reset your Vuprise password',
      textContent: `Your Vuprise password reset code is ${resetCode}. It expires in 10 minutes and can only be used once.\n\nIf you did not request this, ignore this message.`,
      htmlContent: `<p>Your Vuprise password reset code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${resetCode}</p><p>This code expires in 10 minutes and can only be used once.</p><p>If you did not request this, ignore this message.</p>`
    })
  });
  let providerBody = {};
  try { providerBody = await response.json(); } catch { /* A malformed response is handled as provider rejection. */ }
  if (!response.ok || typeof providerBody.messageId !== 'string' || !providerBody.messageId) {
    throw classifyBrevoError({ status: response.status, ...providerBody });
  }
};

const requestPasswordReset = async (req, res, next) => {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const generic = () => res.status(200).json({ success: true, message: genericRequestMessage });
    // Honeypot field: a value here means an automated submission, so answer
    // with the same generic response and skip mail and counters entirely.
    if (typeof req.body.website === 'string' && req.body.website.trim()) return generic();
    if (!process.env.JWT_SECRET || !pepper()) {
      return res.status(503).json({ success: false, message: 'Password recovery is temporarily unavailable.' });
    }
    const mailConfig = getMailConfiguration();
    if (mailConfig.error) return res.status(503).json({ success: false, message: mailConfig.error });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return generic();

    const ipSlot = await reserveCounter(ipKey(req.ip), 20);
    if (!ipSlot) return generic();

    const user = await User.findOne({ email }).select('_id email');
    if (!user) return generic();

    const accountSlot = await reserveCounter(userKey(user._id), 5);
    if (!accountSlot) return generic();

    const resetCode = createResetCode();
    const codeHash = digest(resetCode);
    await PasswordResetState.findOneAndUpdate(
      { user: user._id },
      { $set: {
        codeHash,
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verificationAttempts: 0,
        resetTokenHash: '',
        resetTokenExpiresAt: null,
        consumedAt: null
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await sendResetEmail(user.email, resetCode, mailConfig);
    } catch (mailError) {
      await Promise.all([
        PasswordResetState.updateOne({ user: user._id, codeHash }, { $set: { codeHash: '', codeExpiresAt: null, consumedAt: new Date() } }),
        releaseCounter(userKey(user._id), accountSlot.windowStartedAt)
      ]);
      const deliveryError = mailError?.category ? mailError : classifyBrevoError(mailError);
      console.error('[Password Reset] Email delivery failed:', deliveryError.category);
      return res.status(502).json({ success: false, code: deliveryError.category, message: deliveryError.message });
    }

    return generic();
  } catch (error) { next(error); }
};

const completePasswordReset = async (req, res, next) => {
  try {
    const invalidCode = () => res.status(400).json({ success: false, message: 'The reset code is invalid, expired, or has reached its attempt limit.' });
    // Honeypot field: automated submissions are rejected like an invalid code.
    if (typeof req.body.website === 'string' && req.body.website.trim()) return invalidCode();
    if (!(await reserveCounter(ipKey(req.ip), 100))) {
      return res.status(429).json({ success: false, message: 'Too many reset attempts. Try again later.' });
    }
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const { code, newPassword, confirmPassword } = req.body;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof code !== 'string' || !/^\d{6}$/.test(code)) return invalidCode();
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Password must be between 8 and 128 characters.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    const account = await User.findOne({ email }).select('_id');
    if (!account) return invalidCode();

    const now = new Date();
    const codeHash = digest(code);
    const state = await PasswordResetState.findOneAndUpdate(
      { user: account._id, codeHash, codeExpiresAt: { $gt: now }, consumedAt: null, verificationAttempts: { $lt: 5 } },
      { $set: { consumedAt: now, codeHash: '', codeExpiresAt: null, resetTokenHash: '', resetTokenExpiresAt: null } },
      { new: true }
    );
    if (!state) {
      const failedAttempt = await PasswordResetState.findOneAndUpdate(
        { user: account._id, codeHash: { $ne: codeHash, $nin: ['', null] }, codeExpiresAt: { $gt: now }, consumedAt: null, verificationAttempts: { $lt: 5 } },
        { $inc: { verificationAttempts: 1 } },
        { new: true }
      );
      if (failedAttempt?.verificationAttempts >= 5) {
        await PasswordResetState.updateOne(
          { _id: failedAttempt._id, verificationAttempts: { $gte: 5 } },
          { $set: { codeHash: '', codeExpiresAt: null, consumedAt: now } }
        );
      }
      return invalidCode();
    }

    const user = await User.findById(state.user).select('+password tokenVersion');
    if (!user) return invalidCode();
    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    return res.json({ success: true, message: 'Password reset. Sign in with your new password.' });
  } catch (error) { next(error); }
};

module.exports = { requestPasswordReset, completePasswordReset };
