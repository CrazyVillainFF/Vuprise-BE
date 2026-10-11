const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  about: { type: String, default: '', trim: true, maxlength: 1000 },
  photo: { type: String, default: '' },
  photoPublicId: { type: String, default: '' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  members: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' }, joinedAt: { type: Date, default: Date.now } }],
  invitations: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending' }, createdAt: { type: Date, default: Date.now } }]
}, { timestamps: true, optimisticConcurrency: true });

GroupSchema.index({ 'members.user': 1, updatedAt: -1 });
GroupSchema.index({ 'invitations.user': 1, 'invitations.status': 1 });
GroupSchema.methods.memberFor = function memberFor(userId) { return this.members.find((member) => String(member.user?._id || member.user) === userId.toString()); };
module.exports = mongoose.model('Group', GroupSchema);
