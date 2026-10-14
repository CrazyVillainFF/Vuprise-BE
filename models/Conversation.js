const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  pairKey: { type: String, required: true, unique: true, index: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  // Records who opened a non-mutual conversation. This lets the permission
  // layer distinguish a public account's allowed inbound request from a
  // private account that chose to start the conversation itself.
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  displayNames: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, maxlength: 80, trim: true }
  }],
  isOfficialBroadcast: { type: Boolean, default: false, index: true },
  officialSender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  officialRecipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastMessageAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

ConversationSchema.index({ participants: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', ConversationSchema);
