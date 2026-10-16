const mongoose = require('mongoose');

const AdminBroadcastSchema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, maxlength: 5000, default: '' },
  imageUrl: { type: String, maxlength: 2048, default: '' },
  imagePublicId: { type: String, maxlength: 255, default: '' },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  recipientCount: { type: Number, required: true, min: 1 },
}, { timestamps: true });

AdminBroadcastSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model('AdminBroadcast', AdminBroadcastSchema);
