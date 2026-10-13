const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const EducationSchema = new mongoose.Schema({
  school: { type: String, required: true },
  degree: { type: String },
  fieldOfStudy: { type: String },
  startYear: { type: String },
  endYear: { type: String }
}, { _id: true });

const ExperienceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  company: { type: String, required: true },
  location: { type: String },
  startDate: { type: String },
  endDate: { type: String },
  current: { type: Boolean, default: false },
  description: { type: String }
}, { _id: true });

const EncryptedKeyBackupSchema = new mongoose.Schema({
  formatVersion: { type: Number, required: true, enum: [1] },
  keyVersion: { type: Number, required: true, min: 1 },
  publicKeyFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  kdf: { type: String, required: true, enum: ['PBKDF2-SHA-256'] },
  iterations: { type: Number, required: true, enum: [600000] },
  cipher: { type: String, required: true, enum: ['AES-256-GCM'] },
  salt: { type: String, required: true, maxlength: 64 },
  iv: { type: String, required: true, maxlength: 32 },
  ciphertext: { type: String, required: true, maxlength: 20000 },
  createdAt: { type: Date, default: Date.now }
}, { _id: true });

const ModerationWarningSchema = new mongoose.Schema({
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  acknowledgedAt: { type: Date, default: null },
}, { _id: true });

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide your full name'],
    trim: true,
    maxlength: [80, 'Name cannot exceed 80 characters']
  },
  email: {
    type: String,
    required: [true, 'Please provide an email address'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,})+$/,
      'Please provide a valid email address'
    ]
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  headline: {
    type: String,
    default: 'Professional at Vuprise',
    maxlength: [140, 'Headline cannot exceed 140 characters']
  },
  bio: {
    type: String,
    default: '',
    maxlength: [2000, 'Bio cannot exceed 2000 characters']
  },
  location: {
    type: String,
    default: 'San Francisco, CA'
  },
  locationCountry: { type: String, trim: true, maxlength: 100, default: '' },
  locationCountryCode: { type: String, uppercase: true, match: /^[A-Z]{2}$|^$/, default: '' },
  locationRegion: { type: String, trim: true, maxlength: 120, default: '' },
  locationRegionCode: { type: String, uppercase: true, maxlength: 12, default: '' },
  website: {
    type: String,
    default: ''
  },
  company: {
    type: String,
    default: ''
  },
  jobTitle: {
    type: String,
    default: ''
  },
  accountType: {
    type: String,
    enum: ['student', 'workplace'],
    default: 'workplace'
  },
  profilePicture: {
    type: String,
    default: ''
  },
  coverImage: {
    type: String,
    default: ''
  },
  skills: [{
    type: String,
    trim: true
  }],
  education: [EducationSchema],
  experience: [ExperienceSchema],
  connections: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  blockedUsers: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
    select: false
  },
  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  themePreference: {
    type: String,
    enum: ['light', 'dark', 'system'],
    default: 'light'
  },
  privateAccount: {
    type: Boolean,
    default: false
  },
  hideActivity: {
    type: Boolean,
    default: false,
    select: false
  },
  lastSeenAt: {
    type: Date,
    default: null,
    select: false
  },
  inactivityRemindersEnabled: { type: Boolean, default: true, select: false },
  inactivityReminderSentAt: { type: Date, default: null, select: false },
  inactivityReminderClaimedAt: { type: Date, default: null, select: false },
  inactivityReminderProviderId: { type: String, default: '', select: false, maxlength: 200 },
  encryptionPublicKey: {
    type: String,
    default: '',
    select: false,
    maxlength: 4096
  },
  encryptionSigningPublicKey: {
    type: String,
    default: '',
    select: false,
    maxlength: 4096
  },
  encryptionKeyVersion: {
    type: Number,
    default: 0,
    min: 0
  },
  encryptionKeyBackups: {
    type: [EncryptedKeyBackupSchema],
    default: [],
    select: false
  },
  tokenVersion: {
    type: Number,
    default: 0,
    min: 0
  },
  moderationStatus: { type: String, enum: ['active', 'temporary_ban', 'permanent_ban', 'deletion_pending', 'deleted'], default: 'active', select: false, index: true },
  moderationExpiresAt: { type: Date, default: null, select: false, index: true },
  moderationReason: { type: String, default: '', maxlength: 1000, select: false },
  moderationWarnings: { type: [ModerationWarningSchema], default: [], select: false },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for profile completion percentage
UserSchema.virtual('profileCompletion').get(function () {
  let score = 20; // baseline for created account with name & email
  if (this.headline && !['Professional at Vuprise', 'Professional at NEXORA'].includes(this.headline)) score += 15;
  if (this.bio && this.bio.length > 20) score += 15;
  if (this.profilePicture) score += 15;
  if (this.coverImage) score += 10;
  if (this.skills && this.skills.length > 0) score += 10;
  if (this.experience && this.experience.length > 0) score += 10;
  if (this.education && this.education.length > 0) score += 5;
  return Math.min(score, 100);
});

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Match password helper
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Text index for search
UserSchema.index({ name: 'text', headline: 'text', company: 'text', skills: 'text', location: 'text' });
UserSchema.index({ lastSeenAt: 1, inactivityRemindersEnabled: 1, moderationStatus: 1 });

module.exports = mongoose.model('User', UserSchema);
