const mongoose = require('mongoose');

const GroupMessageSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true, trim: true, maxlength: 5000 },
  clientMessageId: { type: String, maxlength: 80 }
}, { timestamps: true });

GroupMessageSchema.index({ group: 1, createdAt: -1, _id: -1 });
GroupMessageSchema.index(
  { group: 1, sender: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } }
);

module.exports = mongoose.model('GroupMessage', GroupMessageSchema);
