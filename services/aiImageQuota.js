const AiImageQuota = require('../models/AiImageQuota');

// Rolling 24-hour limit: each member can successfully generate at most five AI
// images in any 24-hour window. Nothing here trusts a client-supplied id; the
// caller always passes the authenticated req.user._id.
const AI_IMAGE_DAILY_LIMIT = 5;
const AI_IMAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

const recentCutoff = (now) => new Date(now.getTime() - AI_IMAGE_WINDOW_MS);

const recentTimestamps = (generations, cutoff) => (generations || [])
  .filter((at) => at instanceof Date && at.getTime() >= cutoff.getTime())
  .sort((a, b) => a.getTime() - b.getTime());

const ensureQuotaDoc = async (userId) => {
  try {
    await AiImageQuota.updateOne({ user: userId }, { $setOnInsert: { generations: [] } }, { upsert: true });
  } catch (error) {
    // A concurrent first request may win the upsert race; the unique user
    // index rejects the loser, and the document it wanted now exists.
    if (error?.code !== 11000) throw error;
  }
};

// Atomically reserves one generation slot if fewer than the limit are already
// recent. The reservation is a real timestamp, so an in-flight generation
// counts against the limit and two concurrent requests cannot exceed it.
const reserveImageGeneration = async (userId, now = new Date()) => {
  const cutoff = recentCutoff(now);
  await ensureQuotaDoc(userId);
  const updated = await AiImageQuota.findOneAndUpdate(
    {
      user: userId,
      $expr: {
        $lt: [
          { $size: { $filter: { input: '$generations', as: 'at', cond: { $gte: ['$$at', cutoff] } } } },
          AI_IMAGE_DAILY_LIMIT
        ]
      }
    },
    { $push: { generations: now } },
    { new: true }
  );
  if (updated) {
    const used = recentTimestamps(updated.generations, cutoff).length;
    return { allowed: true, reservedAt: now, remaining: Math.max(0, AI_IMAGE_DAILY_LIMIT - used), nextAvailableAt: null };
  }
  const doc = await AiImageQuota.findOne({ user: userId }).lean();
  const recent = recentTimestamps(doc?.generations, cutoff);
  const oldest = recent[0] || now;
  return { allowed: false, reservedAt: null, remaining: 0, nextAvailableAt: new Date(oldest.getTime() + AI_IMAGE_WINDOW_MS) };
};

// A provider failure (or an aborted request) must not consume quota, so the
// exact reservation timestamp is pulled back out. The reserved Date is stored
// with millisecond precision, so equality matching is reliable.
const releaseImageGeneration = async (userId, reservedAt) => {
  if (!reservedAt) return;
  await AiImageQuota.updateOne({ user: userId }, { $pull: { generations: reservedAt } });
};

// Best-effort housekeeping so the timestamp array does not grow forever.
const pruneImageGenerations = async (userId, now = new Date()) => {
  await AiImageQuota.updateOne({ user: userId }, { $pull: { generations: { $lt: recentCutoff(now) } } });
};

const getImageQuotaStatus = async (userId, now = new Date()) => {
  const cutoff = recentCutoff(now);
  const doc = await AiImageQuota.findOne({ user: userId }).lean();
  const recent = recentTimestamps(doc?.generations, cutoff);
  return {
    limit: AI_IMAGE_DAILY_LIMIT,
    used: recent.length,
    remaining: Math.max(0, AI_IMAGE_DAILY_LIMIT - recent.length),
    nextAvailableAt: recent.length >= AI_IMAGE_DAILY_LIMIT ? new Date(recent[0].getTime() + AI_IMAGE_WINDOW_MS) : null
  };
};

module.exports = {
  AI_IMAGE_DAILY_LIMIT,
  AI_IMAGE_WINDOW_MS,
  reserveImageGeneration,
  releaseImageGeneration,
  pruneImageGenerations,
  getImageQuotaStatus
};
