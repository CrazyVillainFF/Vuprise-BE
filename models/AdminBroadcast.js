const mongoose = require('mongoose');

const AdminBroadcastSchema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true, maxlength: 5000 },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  recipientCount: { type: Number, required: true, min: 1 },
}, { timestamps: true });

AdminBroadcastSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model('AdminBroadcast', AdminBroadcastSchema);
