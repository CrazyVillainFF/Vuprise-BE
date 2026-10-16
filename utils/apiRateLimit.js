const crypto = require('crypto');
const RateLimitCounter = require('../models/RateLimitCounter');

const secret = () => process.env.PASSWORD_RESET_PEPPER || process.env.JWT_SECRET || 'vuprise-local-rate-limit';

// Raw IP addresses and email addresses must not be stored in the counter
// collection, so every key is reduced to an HMAC digest first. The digest is
// only used for counting; it is not reversible without the server secret.
const digestKey = (value) => crypto.createHmac('sha256', secret()).update(String(value)).digest('hex');

// Atomically consumes one slot in the fixed window for the key. Returns true
// when the request is allowed, false once the window limit is reached.
const consumeLimit = async ({ key, windowMs, max, now = new Date() }) => {
  const hashedKey = digestKey(key);
  const cutoff = new Date(now.getTime() - windowMs);
  const expiresAt = new Date(now.getTime() + Math.max(windowMs * 2, 48 * 60 * 60 * 1000));
  await RateLimitCounter.updateOne(
    { key: hashedKey },
    { $setOnInsert: { key: hashedKey, count: 0, windowStartedAt: now, expiresAt } },
    { upsert: true }
  );

  const allowed = await RateLimitCounter.findOneAndUpdate(
    { key: hashedKey, $or: [{ windowStartedAt: { $lte: cutoff } }, { count: { $lt: max } }] },
    [{ $set: {
      count: { $cond: [{ $lte: ['$windowStartedAt', cutoff] }, 1, { $add: ['$count', 1] }] },
      windowStartedAt: { $cond: [{ $lte: ['$windowStartedAt', cutoff] }, now, '$windowStartedAt'] },
      expiresAt
    } }],
    { new: true }
  );
  return Boolean(allowed);
};

// A limiter outage must not take the whole API down, so storage errors fail
// open and are logged for operators instead of blocking legitimate users.
const consumeLimitSafe = async (options) => {
  try {
    return await consumeLimit(options);
  } catch (error) {
    console.warn('[Rate limit] Counter storage unavailable; allowing request:', error.message);
    return true;
  }
};

module.exports = { consumeLimit, consumeLimitSafe, digestKey };
