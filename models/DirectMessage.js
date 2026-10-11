const mongoose = require('mongoose');

const DirectMessageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // New messages are account-authenticated so they work on any signed-in device.
  // Legacy encrypted records keep these fields for backward-compatible history.
  text: { type: String, maxlength: 5000 },
  imageUrl: { type: String, maxlength: 2048, default: '' },
  imagePublicId: { type: String, maxlength: 255, default: '' },
  hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deletedForEveryone: { type: Boolean, default: false },
  ciphertext: { type: String, maxlength: 180000 },
  iv: { type: String, match: /^[A-Za-z0-9+/]{16}={0,2}$/ },
  signature: { type: String, maxlength: 256 },
  wrappedKeys: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    value: { type: String, required: true, maxlength: 2048 }
  }],
  editedAt: { type: Date, default: null },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

DirectMessageSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model('DirectMessage', DirectMessageSchema);
