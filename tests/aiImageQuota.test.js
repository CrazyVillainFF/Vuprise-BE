const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const AiImageQuota = require('../models/AiImageQuota');
const {
  AI_IMAGE_DAILY_LIMIT,
  AI_IMAGE_WINDOW_MS,
  reserveImageGeneration,
  releaseImageGeneration,
  pruneImageGenerations,
  getImageQuotaStatus
} = require('../services/aiImageQuota');

let mongo = null;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test.beforeEach(async () => {
  await AiImageQuota.deleteMany({});
});

const userId = () => new mongoose.Types.ObjectId();

test('the first five generations in a rolling 24 hours are allowed and the sixth is rejected with a retry time', async () => {
  const member = userId();
  const now = new Date('2026-05-01T12:00:00Z');
  for (let index = 0; index < AI_IMAGE_DAILY_LIMIT; index += 1) {
    const result = await reserveImageGeneration(member, new Date(now.getTime() + index * 1000));
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, AI_IMAGE_DAILY_LIMIT - index - 1);
  }
  const rejected = await reserveImageGeneration(member, new Date(now.getTime() + 6000));
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reservedAt, null);
  assert.equal(rejected.remaining, 0);
  assert.equal(rejected.nextAvailableAt.toISOString(), new Date(now.getTime() + AI_IMAGE_WINDOW_MS).toISOString(), 'the retry time is the oldest reservation plus 24 hours');
});

test('generations older than 24 hours no longer count against the limit', async () => {
  const member = userId();
  const start = new Date('2026-05-01T12:00:00Z');
  for (let index = 0; index < AI_IMAGE_DAILY_LIMIT; index += 1) {
    await reserveImageGeneration(member, new Date(start.getTime() + index * 1000));
  }
  const blocked = await reserveImageGeneration(member, new Date(start.getTime() + 60 * 1000));
  assert.equal(blocked.allowed, false);
  const allowed = await reserveImageGeneration(member, new Date(start.getTime() + AI_IMAGE_WINDOW_MS + 2000));
  assert.equal(allowed.allowed, true, 'the two oldest reservations have aged out of the window');
  assert.equal(allowed.remaining, 1);
});

test('releasing a reservation frees the slot for a retry', async () => {
  const member = userId();
  const now = new Date('2026-05-01T12:00:00Z');
  const reservations = [];
  for (let index = 0; index < AI_IMAGE_DAILY_LIMIT; index += 1) {
    reservations.push(await reserveImageGeneration(member, new Date(now.getTime() + index * 1000)));
  }
  assert.equal((await reserveImageGeneration(member, new Date(now.getTime() + 6000))).allowed, false);
  await releaseImageGeneration(member, reservations[2].reservedAt);
  const retry = await reserveImageGeneration(member, new Date(now.getTime() + 7000));
  assert.equal(retry.allowed, true, 'a released slot can be reserved again');
  const status = await getImageQuotaStatus(member, new Date(now.getTime() + 8000));
  assert.equal(status.used, AI_IMAGE_DAILY_LIMIT);
  assert.equal(status.remaining, 0);
});

test('concurrent generations can never exceed the limit', async () => {
  const member = userId();
  const now = new Date('2026-05-01T12:00:00Z');
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => reserveImageGeneration(member, new Date(now.getTime() + index))));
  assert.equal(results.filter((result) => result.allowed).length, AI_IMAGE_DAILY_LIMIT);
  assert.equal(results.filter((result) => !result.allowed).length, 3);
});

test('quotas are tracked independently per user', async () => {
  const first = userId();
  const second = userId();
  const now = new Date('2026-05-01T12:00:00Z');
  for (let index = 0; index < AI_IMAGE_DAILY_LIMIT; index += 1) {
    await reserveImageGeneration(first, now);
  }
  assert.equal((await reserveImageGeneration(first, now)).allowed, false);
  assert.equal((await reserveImageGeneration(second, now)).allowed, true);
});

test('pruning drops aged-out timestamps from the record', async () => {
  const member = userId();
  const now = new Date('2026-05-01T12:00:00Z');
  await reserveImageGeneration(member, new Date(now.getTime() - AI_IMAGE_WINDOW_MS - 60000));
  await reserveImageGeneration(member, now);
  await pruneImageGenerations(member, now);
  const status = await getImageQuotaStatus(member, now);
  assert.equal(status.used, 1);
  assert.equal(status.remaining, AI_IMAGE_DAILY_LIMIT - 1);
});
