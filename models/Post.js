const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  content: {
    type: String,
    trim: true,
    maxlength: [5000, 'Post content cannot exceed 5000 characters']
  },
  image: {
    type: String,
    default: ''
  },
  imagePublicId: { type: String, default: '' },
  mediaType: { type: String, enum: ['image', 'video'], default: 'image' },
  videoUrl: { type: String, default: '' },
  videoPublicId: { type: String, default: '' },
  videoSourceUrl: { type: String, default: '', select: false },
  videoSourcePublicId: { type: String, default: '', select: false },
  videoDuration: { type: Number, min: 0, max: 35, default: null },
  videoSourceDuration: { type: Number, min: 0, default: null, select: false },
  videoTrimStart: { type: Number, min: 0, default: 0, select: false },
  videoTrimEnd: { type: Number, min: 0, default: null, select: false },
  videoThumbnail: { type: String, default: '' },
  videoUploadSession: { type: mongoose.Schema.Types.ObjectId, ref: 'VideoUploadSession', select: false },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  comments: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Comment'
  }],
  tags: [{
    type: String,
    trim: true
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for like count
PostSchema.virtual('likeCount').get(function () {
  return this.likes ? this.likes.length : 0;
});

// Virtual for comment count
PostSchema.virtual('commentCount').get(function () {
  return this.comments ? this.comments.length : 0;
});

// Index for feed queries
PostSchema.index({ createdAt: -1 });
PostSchema.index({ author: 1, createdAt: -1 });
PostSchema.index({ content: 'text' });
PostSchema.index({ videoUploadSession: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Post', PostSchema);
