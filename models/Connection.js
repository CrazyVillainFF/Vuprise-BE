const mongoose = require('mongoose');

const ConnectionSchema = new mongoose.Schema({
  requester: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  pairKey: { type: String, select: false },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending',
    index: true
  }
}, {
  timestamps: true
});

ConnectionSchema.pre('validate', function addPairKey(next) {
  if (this.requester && this.recipient) {
    this.pairKey = [String(this.requester), String(this.recipient)].sort().join(':');
  }
  next();
});

// Canonical key prevents simultaneous requests in opposite directions.
ConnectionSchema.index({ requester: 1, recipient: 1 }, { unique: true });
ConnectionSchema.index({ pairKey: 1 }, { unique: true, partialFilterExpression: { pairKey: { $type: 'string' } } });

module.exports = mongoose.model('Connection', ConnectionSchema);
