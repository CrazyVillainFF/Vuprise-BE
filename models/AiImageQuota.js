const mongoose = require('mongoose');

// One rolling-window quota document per member. Image generations are recorded
// as timestamps in a single document so the limit check and the reservation
// happen atomically in one findOneAndUpdate; concurrent requests therefore
// cannot both pass the check. Records live in MongoDB so the limit survives
// restarts and is shared across server instances.
const aiImageQuotaSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  generations: { type: [Date], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('AiImageQuota', aiImageQuotaSchema);
