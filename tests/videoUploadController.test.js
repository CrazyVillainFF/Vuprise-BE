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
  VideoUploadSession.countDocuments = async () => 0;
  VideoUploadSession.findOne = async () => null;
  VideoUploadSession.create = async (data) => ({ ...data, _id: sessionId });
  cloudinary.utils.api_sign_request = (params, secret) => {
    assert.equal(secret, 'test-secret-not-returned');
    assert.match(params.public_id, new RegExp(`nexora/posts/videos/${userId}/`));
    assert.match(params.context, new RegExp(`user_id=${userId}`));
    assert.equal(params.overwrite, false);
    return 'short-lived-signature';
  };
  const res = response();
  await signUpload({ user: { _id: userId }, body: validRequest() }, res, assert.fail);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.signature, 'short-lived-signature');
  assert.equal(res.body.apiKey, 'test-key');
  assert.equal('apiSecret' in res.body, false);
  assert.equal(JSON.stringify(res.body).includes('test-secret-not-returned'), false);
  assert.equal(res.body.context, `user_id=${userId}|upload_session=${sessionId}`);
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
    resource_type: 'video', format: 'mp4', bytes: 1000, duration: 40,
    context: { custom: { user_id: String(userId), upload_session: String(sessionId) } },
  };
  let destroyed = false;
  let createdPost;
  const postId = new mongoose.Types.ObjectId();
  const populated = { toObject: () => ({ _id: postId, author: { _id: userId } }) };
  VideoUploadSession.findOne = async () => session;
  Post.findOne = () => query(null);
  cloudinary.api.resource = async () => resource;
  cloudinary.uploader.destroy = async () => { destroyed = true; };
  cloudinary.url = (publicId, options) => `https://res.cloudinary.com/test-cloud/${options.resource_type}/upload/${publicId}`;
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

  for (const invalid of [
    { ...resource, context: { custom: { user_id: 'someone-else', upload_session: String(sessionId) } } },
    { ...resource, format: 'avi' },
    { ...resource, bytes: MAX_VIDEO_BYTES + 1 },
    { ...resource, duration: 20 },
  ]) {
    t.test(`rejects provider metadata ${invalid.bytes > MAX_VIDEO_BYTES ? 'with excessive size' : invalid.duration < 30 ? 'with too-short source' : invalid.format !== 'mp4' ? 'with unsupported format' : 'with forged owner context'}`, async () => {
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
