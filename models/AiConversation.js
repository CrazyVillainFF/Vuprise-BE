const mongoose = require('mongoose');

const AiMessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, trim: true, maxlength: 5000, default: '' },
  imageUrl: { type: String, maxlength: 2048, default: null },
  imageUrls: { type: [{ type: String, maxlength: 2048 }], default: [] },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const AiConversationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, trim: true, maxlength: 120, default: 'New chat' },
  opencodeSessionId: { type: String, default: '', select: false },
  messages: { type: [AiMessageSchema], default: [] },
  lastMessageAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

AiConversationSchema.index({ user: 1, lastMessageAt: -1 });

module.exports = mongoose.model('AiConversation', AiConversationSchema);
