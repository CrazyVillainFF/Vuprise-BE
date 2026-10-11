const crypto = require('crypto');

const createResetToken = () => crypto.randomBytes(32).toString('base64url');
const isResetToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const hashResetToken = (token, secret = process.env.PASSWORD_RESET_PEPPER || '') => crypto.createHmac('sha256', secret).update(token).digest('hex');
const safeHashEquals = (left, right) => {
  const leftBytes = Buffer.from(left || '', 'hex'); const rightBytes = Buffer.from(right || '', 'hex');
  return leftBytes.length === rightBytes.length && leftBytes.length > 0 && crypto.timingSafeEqual(leftBytes, rightBytes);
};

module.exports = { createResetToken, isResetToken, hashResetToken, safeHashEquals };
