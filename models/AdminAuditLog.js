const mongoose = require('mongoose');

const AdminAuditLogSchema = new mongoose.Schema({
  targetUser: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true, enum: ['temporary_ban', 'permanent_ban', 'lift_ban', 'warning', 'warning_acknowledged', 'verification_updated', 'broadcast_message', 'user_deleted', 'request_updated', 'report_updated', 'help_updated'] },
  reason: { type: String, maxlength: 1000, default: '' },
  expiresAt: { type: Date, default: null },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportRequest', default: null },
  outcome: { type: String, maxlength: 500, default: '' },
}, { timestamps: true });

AdminAuditLogSchema.index({ createdAt: -1 });
module.exports = mongoose.model('AdminAuditLog', AdminAuditLogSchema);
