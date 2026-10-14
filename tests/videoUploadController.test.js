const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const VideoUploadSession = require('../models/VideoUploadSession');
const Post = require('../models/Post');
const cloudinary = require('../config/cloudinary');
const {
  signUpload,
  publishUploadedVideo,
  validateSignRequest,
  resolveTrimAgainstSource,
  MAX_VIDEO_BYTES,
} = require('../controllers/videoUploadController');

const originalEnv = {
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
};
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret-not-returned';

const original = {
  session: { countDocuments: VideoUploadSession.countDocuments, findOne: VideoUploadSession.findOne, create: VideoUploadSession.create },
  post: { findOne: Post.findOne, findById: Post.findById, create: Post.create },
  utils: { api_sign_request: cloudinary.utils.api_sign_request },
  api: { resource: cloudinary.api.resource },
  uploader: { destroy: cloudinary.uploader.destroy },
  cloudinary: { url: cloudinary.url },
};

const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const validRequest = (overrides = {}) => ({
  mimeType: 'video/mp4',
  fileSize: 8 * 1024 * 1024,
  trimStart: 2,
  trimEnd: 30,
  idempotencyKey: 'upload_request_1234567890',
  ...overrides,
});

const query = (value) => ({
  populate: async () => value,
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

test('server rejects oversized, invalid-format, invalid-trim and malformed upload requests', () => {
  assert.throws(() => validateSignRequest(validRequest({ fileSize: MAX_VIDEO_BYTES + 1 })), { code: 'file_too_large' });
  assert.throws(() => validateSignRequest(validRequest({ mimeType: 'video/x-matroska' })), { code: 'unsupported_format' });
  assert.throws(() => validateSignRequest(validRequest({ trimStart: 0, trimEnd: 35.01 })), { code: 'invalid_trim' });
  assert.equal(validateSignRequest(validRequest({ trimStart: 40, trimEnd: 75 })).trimStart, 40);
  assert.throws(() => validateSignRequest(validRequest({ trimStart: 31, trimEnd: 30 })), { code: 'invalid_trim' });
  assert.throws(() => validateSignRequest(validRequest({ idempotencyKey: 'bad' })), { code: 'invalid_request' });
  const reel = validateSignRequest(validRequest({ trimStart: 52, trimEnd: 80, coverTime: 61, presentation: 'reel', cropMode: 'fit' }));
  assert.equal(reel.trimStart, 52);
  assert.equal(reel.coverTime, 61);
  assert.equal(reel.cropMode, 'fit');
  assert.throws(() => validateSignRequest(validRequest({ presentation: 'reel', coverTime: 31 })), { code: 'invalid_presentation' });
});

test('trim verification accepts an 18-second source ending exactly at browser and provider EOF', () => {
  assert.deepEqual(resolveTrimAgainstSource(18, 0, 18, 18), {
    valid: true, effectiveEnd: 18, clipDuration: 18, endDelta: 0,
  });
});

test('trim verification clamps a browser EOF to Cloudinary EOF when fractional metadata differs', () => {
  const result = resolveTrimAgainstSource(17.9, 0, 18.375, 18.375);
  assert.equal(result.valid, true);
  assert.equal(result.effectiveEnd, 17.9);
  assert.equal(result.clipDuration, 17.9);
});

test('trim verification rejects an end genuinely outside the source tolerance', () => {
  const result = resolveTrimAgainstSource(18, 0, 18.6, 20);
  assert.equal(result.valid, false);
  assert.equal(Number.isNaN(result.effectiveEnd), true);
});

test('trim verification does not clamp an out-of-range interior endpoint', () => {
  assert.equal(resolveTrimAgainstSource(18, 0, 18.6, 18.8).valid, false);
});

test('publish clamps only a browser-reported source EOF to the verified Cloudinary EOF', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const postId = new mongoose.Types.ObjectId();
  const session = {
    _id: sessionId, user: userId, publicId: 'nexora/posts/videos/eof-check', status: 'uploading',
    mimeType: 'video/mp4', declaredBytes: 1000, trimStart: 0, trimEnd: 18.8,
    clientVideoDuration: 18.8, createdAt: new Date(), authorizationIssuedAt: new Date(),
    async save() { this.saved = true; },
  };
  const storedPost = { toObject: () => ({ _id: postId, author: userId }) };
  let createdPost;
  VideoUploadSession.findOne = async () => session;
  Post.findOne = () => query(null);
  Post.create = async (fields) => { createdPost = fields; return { ...fields, _id: postId }; };
  Post.findById = () => ({ populate: async () => storedPost });
  cloudinary.url = (publicId) => `https://res.cloudinary.test/${publicId}`;
  cloudinary.api.resource = async () => ({
    resource_type: 'video', public_id: session.publicId, format: 'mp4', bytes: 1000, duration: 18,
  });
  const res = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId), clientVideoDuration: 18.8 } }, res, assert.fail);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(session.status, 'published');
  assert.equal(createdPost.videoTrimEnd, 18);
  assert.equal(createdPost.videoDuration, 18);
});

test('unauthorized callers cannot receive a signed upload authorization', async () => {
  const res = response();
  await signUpload({ body: validRequest() }, res, assert.fail);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'unauthorized');
});

test('signing validates auth input and returns scoped Cloudinary fields without the API secret', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  let createdSessionData;
  VideoUploadSession.countDocuments = async () => 0;
  VideoUploadSession.findOne = async () => null;
  VideoUploadSession.create = async (data) => { createdSessionData = data; return { ...data, _id: sessionId }; };
  cloudinary.utils.api_sign_request = (params, secret) => {
    assert.equal(secret, 'test-secret-not-returned');
    assert.match(params.public_id, new RegExp(`nexora/posts/videos/${userId}/`));
    assert.match(params.context, new RegExp(`user_id=${userId}`));
    assert.equal(params.overwrite, false);
    return 'short-lived-signature';
  };
  const res = response();
  await signUpload({ user: { _id: userId }, body: validRequest({ clientVideoDuration: 32 }) }, res, assert.fail);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.signature, 'short-lived-signature');
  assert.equal(res.body.apiKey, 'test-key');
  assert.equal('apiSecret' in res.body, false);
  assert.equal(JSON.stringify(res.body).includes('test-secret-not-returned'), false);
  assert.equal(res.body.context, `user_id=${userId}|upload_session=${sessionId}`);
  assert.equal(createdSessionData.clientVideoDuration, 32);
});

test('publish refuses to finalize a session owned by another user', async () => {
  VideoUploadSession.findOne = async () => null;
  const res = response();
  await publishUploadedVideo({ user: { _id: new mongoose.Types.ObjectId() }, body: { uploadId: new mongoose.Types.ObjectId().toString() } }, res, assert.fail);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'upload_not_found');
});

test('publish independently validates ownership, format, size, duration and clip range', async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const session = {
    _id: sessionId, user: userId, publicId: 'nexora/posts/videos/owned', status: 'uploading',
    mimeType: 'video/mp4', declaredBytes: 1000, trimStart: 0, trimEnd: 30,
    createdAt: new Date(), authorizationIssuedAt: new Date(), async save() { this.saved = true; },
  };
  let resource = {
    resource_type: 'video', public_id: 'nexora/posts/videos/owned', format: 'mp4', bytes: 1000, duration: 40,
    context: { custom: { user_id: String(userId), upload_session: String(sessionId) } },
  };
  let destroyed = false;
  let createdPost;
  let deliveredTransforms = [];
  const postId = new mongoose.Types.ObjectId();
  const populated = { toObject: () => ({ _id: postId, author: { _id: userId } }) };
  VideoUploadSession.findOne = async () => session;
  Post.findOne = () => query(null);
  cloudinary.api.resource = async () => resource;
  cloudinary.uploader.destroy = async () => { destroyed = true; };
  cloudinary.url = (publicId, options) => { deliveredTransforms.push(options.transformation[0]); return `https://res.cloudinary.com/test-cloud/${options.resource_type}/upload/${publicId}`; };
  Post.create = async (data) => { createdPost = data; return { ...data, _id: postId }; };
  Post.findById = () => ({ populate: async () => populated });

  let res = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId), content: 'Hello #video' } }, res, assert.fail);
  assert.equal(res.statusCode, 201);
  assert.equal(createdPost.videoDuration, 30);
  assert.equal(createdPost.videoUrl.includes('nexora/posts/videos/owned'), true);
  assert.equal(createdPost.tags[0], 'video');
  assert.equal(session.status, 'published');
  assert.equal(res.body.post.isLiked, false);
  assert.equal(deliveredTransforms[0].width, undefined);

  session.presentation = 'reel';
  session.cropMode = 'cover';
  session.coverTime = 18;
  session.status = 'uploading';
  deliveredTransforms = [];
  const reelResponse = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId), content: 'Vertical #reel' } }, reelResponse, assert.fail);
  assert.equal(reelResponse.statusCode, 201);
  assert.equal(createdPost.videoPresentation, 'reel');
  assert.equal(createdPost.videoCropMode, 'cover');
  assert.equal(createdPost.videoCoverTime, 18);
  assert.equal(deliveredTransforms[0].width, undefined);
  assert.equal(deliveredTransforms[0].height, undefined);
  assert.equal(deliveredTransforms[0].start_offset, 0);
  assert.equal(deliveredTransforms[0].end_offset, 30);
  assert.equal(deliveredTransforms[1].start_offset, 18);

  // Container metadata often differs slightly between browser and Cloudinary;
  // a clip ending within the tolerance should publish instead of being deleted.
  resource = { ...resource, duration: 29.8 };
  session.status = 'uploading';
  destroyed = false;
  const durationDriftResponse = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId) } }, durationDriftResponse, assert.fail);
  assert.equal(durationDriftResponse.statusCode, 201);
  assert.equal(session.status, 'published');
  assert.equal(destroyed, false);
  assert.equal(createdPost.videoDuration, 29.8);
  assert.equal(createdPost.videoTrimEnd, 29.8);

  // The authenticated database session and generated public ID remain
  // authoritative when Cloudinary omits optional custom context in a response.
  resource = { ...resource, duration: 40, context: undefined };
  session.status = 'uploading';
  const missingContextResponse = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId) } }, missingContextResponse, assert.fail);
  assert.equal(missingContextResponse.statusCode, 201);

  for (const [reason, invalid] of [
    ['forged owner context', { ...resource, context: { custom: { user_id: 'someone-else', upload_session: String(sessionId) } } }],
    ['mismatched public ID', { ...resource, public_id: 'nexora/posts/videos/another-upload' }],
    ['unsupported format', { ...resource, format: 'avi' }],
    ['excessive size', { ...resource, bytes: MAX_VIDEO_BYTES + 1 }],
    ['too-short source', { ...resource, duration: 20 }],
  ]) {
    t.test(`rejects provider metadata with ${reason}`, async () => {
      resource = invalid;
      session.status = 'uploading';
      destroyed = false;
      const rejected = response();
      await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId) } }, rejected, assert.fail);
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.body.code, 'video_validation_failed');
      assert.equal(destroyed, true);
    });
  }
});

test('storage outage and interrupted browser transfer remain retryable', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const session = { _id: sessionId, user: userId, publicId: 'nexora/posts/videos/pending', status: 'uploading', createdAt: new Date(), authorizationIssuedAt: new Date(), declaredBytes: 1000 };
  VideoUploadSession.findOne = async () => session;
  Post.findOne = () => query(null);
  cloudinary.api.resource = async () => { throw Object.assign(new Error('private provider detail'), { http_code: 404 }); };
  const res = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId) } }, res, assert.fail);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'upload_incomplete');
  assert.equal(JSON.stringify(res.body).includes('private provider detail'), false);

  cloudinary.api.resource = async () => { throw Object.assign(new Error('private provider detail'), { http_code: 503 }); };
  const storageFailure = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId) } }, storageFailure, assert.fail);
  assert.equal(storageFailure.statusCode, 502);
  assert.equal(storageFailure.body.code, 'storage_error');
  assert.equal(JSON.stringify(storageFailure.body).includes('private provider detail'), false);
});

test('duplicate publish retry returns the existing post without creating a second post', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const existing = { _id: new mongoose.Types.ObjectId(), content: 'already published' };
  VideoUploadSession.findOne = async () => ({ _id: sessionId, user: userId });
  Post.findOne = () => query(existing);
  let providerWasCalled = false;
  cloudinary.api.resource = async () => { providerWasCalled = true; throw new Error('should not call'); };
  const res = response();
  await publishUploadedVideo({ user: { _id: userId }, body: { uploadId: String(sessionId) } }, res, assert.fail);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.post, existing);
  assert.equal(providerWasCalled, false);
});

test.after(() => {
  Object.assign(VideoUploadSession, original.session);
  Object.assign(Post, original.post);
  Object.assign(cloudinary.utils, original.utils);
  Object.assign(cloudinary.api, original.api);
  Object.assign(cloudinary.uploader, original.uploader);
  Object.assign(cloudinary, original.cloudinary);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
