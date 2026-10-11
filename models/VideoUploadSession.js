const mongoose = require('mongoose');

const VideoUploadSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  idempotencyKey: { type: String, required: true, maxlength: 80 },
  publicId: { type: String, required: true, unique: true },
  trimStart: { type: Number, required: true, min: 0 },
  trimEnd: { type: Number, required: true, min: 0, max: 35 },
  declaredBytes: { type: Number, required: true, min: 1 },
  mimeType: { type: String, required: true, enum: ['video/mp4', 'video/webm', 'video/quicktime'] },
  status: { type: String, enum: ['uploading', 'published', 'rejected'], default: 'uploading', index: true },
  authorizationIssuedAt: { type: Date, default: Date.now, required: true },
  post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },
  cleanupAfter: { type: Date, required: true },
}, { timestamps: true });

VideoUploadSessionSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
VideoUploadSessionSchema.index({ cleanupAfter: 1, status: 1 });

module.exports = mongoose.model('VideoUploadSession', VideoUploadSessionSchema);
