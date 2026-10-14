const crypto = require('crypto');
const mongoose = require('mongoose');
const Post = require('../models/Post');
const VideoUploadSession = require('../models/VideoUploadSession');
const cloudinary = require('../config/cloudinary');

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_CLIP_SECONDS = 35;
const SIGNATURE_VALIDITY_MS = 60 * 60 * 1000;
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const ALLOWED_MIME_FORMATS = Object.freeze({
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
});

const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });
const isCloudinaryConfigured = () => Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
const reportMetric = (event, startedAt, bytes, category = 'ok') => {
  const memory = process.memoryUsage();
  console.info('[video-upload]', JSON.stringify({
    event,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    bytes: Number.isFinite(bytes) ? bytes : undefined,
    category,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  }));
};

const validateSignRequest = ({ mimeType, fileSize, trimStart, trimEnd, idempotencyKey, presentation = 'post', cropMode = 'cover', coverTime }) => {
  const start = Number(trimStart);
  const end = Number(trimEnd);
  const size = Number(fileSize);
  if (!ALLOWED_MIME_FORMATS[mimeType]) throw httpError(415, 'Choose an MP4, WebM, or MOV video.', 'unsupported_format');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) throw httpError(413, 'Videos must be smaller than 250MB.', 'file_too_large');
  // Trim positions are absolute offsets into the source video. A 30-second
  // selection beginning at 40s is valid; only its duration must be <= 35s.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > MAX_CLIP_SECONDS + 0.001) {
    throw httpError(400, 'Choose a valid video clip that is 35 seconds or shorter.', 'invalid_trim');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) {
    throw httpError(400, 'The upload could not be started. Please retry.', 'invalid_request');
  }
  const cover = coverTime === undefined ? start : Number(coverTime);
  if (!['post', 'reel'].includes(presentation) || !['cover', 'fit'].includes(cropMode) || !Number.isFinite(cover) || cover < start || cover > end) {
    throw httpError(400, 'Choose a valid Reel layout and cover frame.', 'invalid_presentation');
  }
  return { mimeType, fileSize: size, trimStart: start, trimEnd: end, idempotencyKey, presentation, cropMode, coverTime: cover };
};

const signUpload = async (req, res, next) => {
  const startedAt = Date.now();
  let declaredBytes;
  try {
    if (!req.user?._id) throw httpError(401, 'Sign in to publish a video.', 'unauthorized');
    if (!isCloudinaryConfigured()) throw httpError(503, 'Video publishing is temporarily unavailable. Cloud storage is not configured.', 'storage_unavailable');
    const input = validateSignRequest(req.body || {});
    declaredBytes = input.fileSize;

    const recentUploads = await VideoUploadSession.countDocuments({ user: req.user._id, createdAt: { $gte: new Date(Date.now() - 60_000) } });
    if (recentUploads >= 5) throw httpError(429, 'Too many video upload attempts. Please wait a minute and try again.', 'rate_limited');

    let session = await VideoUploadSession.findOne({ user: req.user._id, idempotencyKey: input.idempotencyKey });
    if (session?.status === 'published') {
      const post = await Post.findOne({ videoUploadSession: session._id }).populate('author', 'name headline profilePicture company jobTitle location');
      return res.status(200).json({ success: true, alreadyPublished: Boolean(post), post: post || undefined, uploadId: String(session._id) });
    }
    if (session?.status === 'rejected') throw httpError(400, 'This upload was rejected. Select the video again to retry.', 'upload_rejected');

    if (!session) {
      const sessionId = new mongoose.Types.ObjectId();
      const publicId = `nexora/posts/videos/${req.user._id}/${crypto.randomBytes(18).toString('hex')}`;
      session = await VideoUploadSession.create({
        _id: sessionId,
        user: req.user._id,
        idempotencyKey: input.idempotencyKey,
        publicId,
        trimStart: input.trimStart,
        trimEnd: input.trimEnd,
        presentation: input.presentation,
        cropMode: input.cropMode,
        coverTime: input.coverTime,
        declaredBytes: input.fileSize,
        mimeType: input.mimeType,
        authorizationIssuedAt: new Date(),
        cleanupAfter: new Date(Date.now() + CLEANUP_AFTER_MS),
      });
    } else if (session.declaredBytes !== input.fileSize || session.mimeType !== input.mimeType || session.trimStart !== input.trimStart || session.trimEnd !== input.trimEnd || (session.presentation || 'post') !== input.presentation || (session.cropMode || 'cover') !== input.cropMode || (session.coverTime ?? session.trimStart) !== input.coverTime) {
      throw httpError(409, 'The selected video or trim range changed. Select the video again to retry.', 'upload_mismatch');
    } else {
      // Refresh the ticket's provider timestamp for a safe retry using the same idempotency key.
      session.authorizationIssuedAt = new Date();
      session.cleanupAfter = new Date(Date.now() + CLEANUP_AFTER_MS);
      await session.save();
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const uploadParams = {
      timestamp,
      public_id: session.publicId,
      overwrite: false,
      allowed_formats: 'mp4,webm,mov,m4v',
      context: `user_id=${String(req.user._id)}|upload_session=${String(session._id)}`,
    };
    const signature = cloudinary.utils.api_sign_request(uploadParams, process.env.CLOUDINARY_API_SECRET);
    reportMetric('authorization-issued', startedAt, declaredBytes);
    return res.status(200).json({
      success: true,
      uploadId: String(session._id),
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      signature,
      timestamp,
      publicId: session.publicId,
      overwrite: false,
      allowed_formats: uploadParams.allowed_formats,
      context: uploadParams.context,
      authorizationExpiresAt: new Date(Date.now() + SIGNATURE_VALIDITY_MS).toISOString(),
    });
  } catch (error) {
    const category = error.code || (error.name === 'MongoServerError' ? 'database_error' : 'authorization_error');
    reportMetric('authorization-failed', startedAt, declaredBytes, category);
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

const makeVideoUrls = (publicId, start, end, presentation = 'post', cropMode = 'cover', coverTime = start) => ({
  videoUrl: cloudinary.url(publicId, {
    secure: true,
    resource_type: 'video',
    format: 'mp4',
    transformation: [{
      start_offset: start,
      end_offset: end,
      // Keep the delivered clip's encoded frame geometry intact. Some video
      // sources fail Cloudinary's automatic-gravity crop/transcode path and
      // are delivered as black frames; the client applies portrait cover/fit
      // in the player while this transformation only performs the trim.
      video_codec: 'h264',
    }],
  }),
  videoThumbnail: cloudinary.url(publicId, {
    secure: true,
    resource_type: 'video',
    format: 'jpg',
    transformation: [{ start_offset: coverTime, width: 640, crop: 'limit' }],
  }),
});

const publishUploadedVideo = async (req, res, next) => {
  const startedAt = Date.now();
  let session;
  try {
    if (!req.user?._id) throw httpError(401, 'Sign in to publish a video.', 'unauthorized');
    if (!isCloudinaryConfigured()) throw httpError(503, 'Video publishing is temporarily unavailable. Cloud storage is not configured.', 'storage_unavailable');
    const { uploadId, content = '' } = req.body || {};
    if (!mongoose.isValidObjectId(uploadId)) throw httpError(400, 'The video upload session is invalid.', 'invalid_upload');
    if (typeof content !== 'string' || content.length > 5000) throw httpError(400, 'Post text must be 5000 characters or fewer.', 'invalid_content');

    session = await VideoUploadSession.findOne({ _id: uploadId, user: req.user._id });
    if (!session) throw httpError(404, 'This upload authorization was not found. Start the upload again.', 'upload_not_found');
    const existingPost = await Post.findOne({ videoUploadSession: session._id }).populate('author', 'name headline profilePicture company jobTitle location');
    if (existingPost) return res.status(200).json({ success: true, message: 'Post published successfully.', post: existingPost });
    if (session.status !== 'uploading' || Date.now() - session.authorizationIssuedAt.getTime() > SIGNATURE_VALIDITY_MS) {
      throw httpError(410, 'Upload authorization expired. Retry publishing to receive a fresh authorization.', 'authorization_expired');
    }

    let resource;
    try {
      resource = await cloudinary.api.resource(session.publicId, { resource_type: 'video', type: 'upload', context: true });
    } catch (providerError) {
      reportMetric('metadata-verification-failed', startedAt, session.declaredBytes, providerError.http_code === 404 ? 'asset_not_ready' : 'storage_error');
      if (providerError.http_code === 404) throw httpError(409, 'The video upload has not finished yet. Wait for it to complete, then retry publishing.', 'upload_incomplete');
      const storageError = httpError(502, 'Cloud storage could not verify the video. Retry publishing; your selected file is still available.', 'storage_error');
      storageError.cause = providerError;
      throw storageError;
    }
    const formats = ALLOWED_MIME_FORMATS[session.mimeType];
    const context = resource.context?.custom || resource.context || {};
    const sourceDuration = Number(resource.duration);
    const resourceBytes = Number(resource.bytes);
    const isOwned = context.user_id === String(req.user._id) && context.upload_session === String(session._id);
    const validFormat = formats?.includes(String(resource.format || '').toLowerCase());
    const validDuration = Number.isFinite(sourceDuration) && sourceDuration >= session.trimEnd && session.trimEnd - session.trimStart <= MAX_CLIP_SECONDS + 0.001;
    if (resource.resource_type !== 'video' || !isOwned || !validFormat || !Number.isFinite(resourceBytes) || resourceBytes <= 0 || resourceBytes > MAX_VIDEO_BYTES || !validDuration) {
      session.status = 'rejected';
      await session.save();
      await cloudinary.uploader.destroy(session.publicId, { resource_type: 'video', invalidate: true }).catch(() => {});
      throw httpError(400, resourceBytes > MAX_VIDEO_BYTES ? 'The uploaded video exceeds the 250MB limit.' : 'The uploaded video or selected trim range could not be verified.', 'video_validation_failed');
    }

    const contentText = content.trim();
    const tags = [...new Set((contentText.match(/#[a-zA-Z0-9_]+/g) || []).map((tag) => tag.slice(1).toLowerCase()))];
    const { videoUrl, videoThumbnail } = makeVideoUrls(session.publicId, session.trimStart, session.trimEnd, session.presentation, session.cropMode, session.coverTime);
    let post;
    try {
      post = await Post.create({
        author: req.user._id,
        content: contentText,
        tags,
        mediaType: 'video',
        videoUrl,
        videoPublicId: session.publicId,
        videoSourceUrl: '',
        videoSourcePublicId: '',
        videoSourceDuration: sourceDuration,
        videoDuration: session.trimEnd - session.trimStart,
        videoPresentation: session.presentation,
        videoCropMode: session.cropMode,
        videoCoverTime: session.coverTime,
        videoTrimStart: session.trimStart,
        videoTrimEnd: session.trimEnd,
        videoThumbnail,
        videoUploadSession: session._id,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      post = await Post.findOne({ videoUploadSession: session._id });
      if (!post) throw error;
    }
    session.status = 'published';
    session.post = post._id;
    await session.save();
    const populatedPost = await Post.findById(post._id).populate('author', 'name headline profilePicture company jobTitle location');
    const postObj = populatedPost.toObject();
    postObj.isLiked = false;
    postObj.likeCount = 0;
    postObj.commentCount = 0;
    reportMetric('published', startedAt, resourceBytes);
    return res.status(201).json({ success: true, message: 'Post published successfully.', post: postObj });
  } catch (error) {
    reportMetric('publish-failed', startedAt, session?.declaredBytes, error.code || (error.name === 'MongoServerError' ? 'database_error' : 'publish_error'));
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

let cleanupRunning = false;
const cleanupAbandonedVideoUploads = async () => {
  if (cleanupRunning || !isCloudinaryConfigured()) return;
  cleanupRunning = true;
  try {
    const staleSessions = await VideoUploadSession.find({ status: 'uploading', cleanupAfter: { $lte: new Date() } }).limit(20);
    for (const session of staleSessions) {
      const post = await Post.findOne({ videoUploadSession: session._id }).select('_id');
      if (post) {
        session.status = 'published';
        session.post = post._id;
        await session.save();
        continue;
      }
      await cloudinary.uploader.destroy(session.publicId, { resource_type: 'video', invalidate: true }).catch(() => {});
      session.status = 'rejected';
      await session.save();
    }
  } catch (error) {
    console.error('[video-upload] abandoned-upload cleanup failed:', error.name || 'cleanup_error');
  } finally {
    cleanupRunning = false;
  }
};

module.exports = { signUpload, publishUploadedVideo, cleanupAbandonedVideoUploads, validateSignRequest, makeVideoUrls, MAX_VIDEO_BYTES, MAX_CLIP_SECONDS };
