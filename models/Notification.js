const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['connection_request', 'connection_accepted', 'group_invitation', 'post_like', 'post_comment'],
    required: true
  },
  post: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post'
  },
  connection: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Connection',
    default: null
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group',
    default: null
  },
  message: {
    type: String,
    required: true
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

NotificationSchema.index({ recipient: 1, createdAt: -1 });
NotificationSchema.index(
  { recipient: 1, connection: 1, type: 1 },
  { unique: true, partialFilterExpression: { connection: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Notification', NotificationSchema);
