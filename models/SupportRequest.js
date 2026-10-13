const mongoose = require('mongoose');

const SupportNoteSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 3000 },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const SupportRequestSchema = new mongoose.Schema({
  type: { type: String, enum: ['temporary_ban_appeal', 'permanent_ban_appeal', 'deleted_account_inquiry', 'general_help', 'report', 'other'], required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  subject: { type: String, required: true, trim: true, maxlength: 160 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  category: { type: String, trim: true, maxlength: 80, default: '' },
  reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reportedPost: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  reportedMessage: { type: mongoose.Schema.Types.ObjectId, refPath: 'reportedMessageModel', default: null },
  reportedMessageModel: { type: String, enum: ['DirectMessage', 'GroupMessage'], default: undefined },
  reportedMessageScope: { type: String, enum: ['direct', 'group'], default: undefined },
  reportedThread: { type: mongoose.Schema.Types.ObjectId, refPath: 'reportedThreadModel', default: null },
  reportedThreadModel: { type: String, enum: ['Conversation', 'Group'], default: undefined },
  evidenceUrls: [{ type: String, maxlength: 2048 }],
  status: { type: String, enum: ['pending', 'under_review', 'approved', 'rejected', 'resolved'], default: 'pending', index: true },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', index: true },
  adminNotes: { type: [SupportNoteSchema], default: [] },
  resolution: { type: String, trim: true, maxlength: 2000, default: '' },
  resolutionOutcome: { type: String, trim: true, maxlength: 60, default: '' },
  replySentAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });

SupportRequestSchema.index({ type: 1, status: 1, createdAt: -1 });
SupportRequestSchema.index({ email: 1, createdAt: -1 });
SupportRequestSchema.index({ reportedUser: 1, createdAt: -1 });
SupportRequestSchema.index({ reportedPost: 1, createdAt: -1 });
SupportRequestSchema.index({ reportedMessage: 1, createdAt: -1 });

module.exports = mongoose.model('SupportRequest', SupportRequestSchema);
