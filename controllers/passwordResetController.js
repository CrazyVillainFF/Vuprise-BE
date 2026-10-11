const User = require('../models/User');
const PasswordResetState = require('../models/PasswordResetState');
const PasswordResetCounter = require('../models/PasswordResetCounter');
const { createResetToken, isResetToken, hashResetToken } = require('../utils/passwordResetSecurity');

const genericRequestMessage = 'If an account matches and the email provider accepts delivery to this address, a reset link will be sent.';
const defaultClientUrl = 'https://nexora-lac-three.vercel.app';
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
  const apiKey = process.env.BREVO_API_KEY;
  const from = process.env.PASSWORD_RESET_FROM || 'vupriseofficial@gmail.com';
  let clientUrl;

  try {
    clientUrl = new URL(process.env.CLIENT_URL || defaultClientUrl);
  } catch {
    return { error: 'The password-reset website URL is invalid.' };
  }

  const isLocalHttp = clientUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(clientUrl.hostname);
  if ((clientUrl.protocol !== 'https:' && !isLocalHttp) || clientUrl.username || clientUrl.password || clientUrl.search || clientUrl.hash || (clientUrl.pathname !== '/' && clientUrl.pathname !== '')) {
    return { error: 'The password-reset website URL must be a secure website origin.' };
  }
  if (!apiKey) return { error: 'Brevo email delivery is not configured on the server.' };
  if (!/^(?:[^<>\r\n]+\s<)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+(?:>)?$/.test(from)) {
    return { error: 'The configured password-reset sender address is invalid.' };
  }

  return { apiKey, from, clientUrl };
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
      message: 'Brevo rejected the configured sender. Check PASSWORD_RESET_FROM and verify that sender in Brevo. No email was sent.'
    };
  }
  return {
    category: 'provider_rejected',
    message: 'Brevo could not accept the password-reset email. No email was sent; check the Brevo transactional email logs and try again.'
  };
};

const sendResetEmail = async (to, resetUrl, mailConfig) => {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': mailConfig.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: mailConfig.from, name: 'Vuprise' },
      to: [{ email: to }],
      subject: 'Reset your Vuprise password',
      textContent: `Use this link to reset your Vuprise password. It expires in 10 minutes and can only be used once: ${resetUrl.href}\n\nIf you did not request this, ignore this message.`,
      htmlContent: `<p>Use the link below to reset your Vuprise password. It expires in 10 minutes and can only be used once.</p><p><a href="${resetUrl.href}">Reset password</a></p><p>If you did not request this, ignore this message.</p>`
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
    if (!process.env.JWT_SECRET || !pepper()) {
      return res.status(503).json({ success: false, message: 'Password recovery is temporarily unavailable.' });
    }
    const mailConfig = getMailConfiguration();
    if (mailConfig.error) return res.status(503).json({ success: false, message: mailConfig.error });
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const generic = () => res.status(200).json({ success: true, message: genericRequestMessage });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return generic();

    const ipSlot = await reserveCounter(ipKey(req.ip), 20);
    if (!ipSlot) return generic();

    const user = await User.findOne({ email }).select('_id email');
    if (!user) return generic();

    const accountSlot = await reserveCounter(userKey(user._id), 5);
    if (!accountSlot) return generic();

    const resetToken = createResetToken();
    const tokenHash = digest(resetToken);
    const resetUrl = new URL('/forgot-password', mailConfig.clientUrl);
    resetUrl.searchParams.set('token', resetToken);
    await PasswordResetState.findOneAndUpdate(
      { user: user._id },
      { $set: {
        codeHash: '',
        codeExpiresAt: null,
        verificationAttempts: 0,
        resetTokenHash: tokenHash,
        resetTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        consumedAt: null
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    try {
      await sendResetEmail(user.email, resetUrl, mailConfig);
    } catch (mailError) {
      await Promise.all([
        PasswordResetState.updateOne({ user: user._id, resetTokenHash: tokenHash }, { $set: { resetTokenHash: '', resetTokenExpiresAt: null } }),
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
    if (!(await reserveCounter(ipKey(req.ip), 100))) {
      return res.status(429).json({ success: false, message: 'Too many reset attempts. Try again later.' });
    }
    const { resetToken, newPassword, confirmPassword } = req.body;
    if (!isResetToken(resetToken)) {
      return res.status(400).json({ success: false, message: 'The reset authorization is invalid or expired.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Password must be between 8 and 128 characters.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    const now = new Date();
    const state = await PasswordResetState.findOneAndUpdate(
      { resetTokenHash: digest(resetToken), resetTokenExpiresAt: { $gt: now }, consumedAt: null },
      { $set: { consumedAt: now, resetTokenHash: '', resetTokenExpiresAt: null, codeHash: '', codeExpiresAt: null } },
      { new: true }
    );
    if (!state) return res.status(400).json({ success: false, message: 'The reset authorization is invalid or expired.' });

    const user = await User.findById(state.user).select('+password tokenVersion');
    if (!user) return res.status(400).json({ success: false, message: 'The reset authorization is invalid or expired.' });
    user.password = newPassword;
    user.tokenVersion += 1;
    await user.save();
    return res.json({ success: true, message: 'Password reset. Sign in with your new password.' });
  } catch (error) { next(error); }
};

module.exports = { requestPasswordReset, completePasswordReset };
