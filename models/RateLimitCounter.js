const mongoose = require('mongoose');

// Durable fixed-window counters shared by every server instance, so abuse
// limits survive restarts and work if the service is later scaled beyond a
// single instance. Keys are always stored as non-reversible HMAC digests.
const RateLimitCounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  count: { type: Number, default: 0, min: 0 },
  windowStartedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, expires: 0 }
}, { timestamps: true });

module.exports = mongoose.model('RateLimitCounter', RateLimitCounterSchema);
