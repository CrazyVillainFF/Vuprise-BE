const RateLimitCounter = require('../../models/RateLimitCounter');

// In-memory stand-in for the RateLimitCounter model, used by controller tests.
// It mirrors the fixed-window semantics of utils/apiRateLimit.js so limits can
// be exercised without a database connection.
const installRateLimitCounter = ({ windowMs = 60 * 60 * 1000, max = 5 } = {}) => {
  const state = new Map();
  const original = { updateOne: RateLimitCounter.updateOne, findOneAndUpdate: RateLimitCounter.findOneAndUpdate };
  RateLimitCounter.updateOne = async (filter) => {
    if (!state.has(filter.key)) state.set(filter.key, { startedAt: Date.now(), count: 0 });
    return { acknowledged: true };
  };
  RateLimitCounter.findOneAndUpdate = async (filter) => {
    const entry = state.get(filter.key);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.startedAt >= windowMs) {
      entry.startedAt = now;
      entry.count = 1;
      return { ...entry };
    }
    if (entry.count >= max) return null;
    entry.count += 1;
    return { ...entry };
  };
  return {
    state,
    restore: () => {
      RateLimitCounter.updateOne = original.updateOne;
      RateLimitCounter.findOneAndUpdate = original.findOneAndUpdate;
    }
  };
};

module.exports = { installRateLimitCounter };
