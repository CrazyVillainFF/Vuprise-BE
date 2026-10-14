const crypto = require('crypto');
const mongoose = require('mongoose');
const Post = require('../models/Post');
const VideoUploadSession = require('../models/VideoUploadSession');
const cloudinary = require('../config/cloudinary');

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_CLIP_SECONDS = 35;
const TRIM_SLIDER_STEP_SECONDS = 0.05;
// Browsers and Cloudinary can report container duration with small rounding
// differences. The clip endpoint naturally clamps a trim at the true EOF.
const SOURCE_DURATION_TOLERANCE_SECONDS = 0.25;
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

const resolveTrimAgainstSource = (sourceDuration, trimStart, requestedTrimEnd, clientVideoDuration) => {
  const duration = Number(sourceDuration);
  const start = Number(trimStart);
  const requestedEnd = Number(requestedTrimEnd);
  const browserDuration = Number(clientVideoDuration);
  const finite = Number.isFinite(duration) && duration > 0 && Number.isFinite(start) && Number.isFinite(requestedEnd);
  const endDelta = finite ? requestedEnd - duration : Infinity;
  // When the user selected the actual end of the browser-read source, a
  // parser disagreement must not turn that endpoint into an invalid interior
  // trim. Clamp only to Cloudinary's verified EOF; never extend the asset or
  // waive an out-of-range interior trim.
  // Slider positions are quantized to 50ms. Account only for floating-point
  // representation noise at that boundary (for example, 18.05 - 18 can be
  // 0.05000000000000071), not a larger duration mismatch.
  const browserEofDelta = Math.abs(requestedEnd - browserDuration);
  const floatingPointSlack = Number.EPSILON * Math.max(1, Math.abs(requestedEnd), Math.abs(browserDuration)) * 4;
  const selectedBrowserEof = Number.isFinite(browserDuration) && browserDuration > 0
    && browserEofDelta <= TRIM_SLIDER_STEP_SECONDS + floatingPointSlack;
  const withinSource = finite && (endDelta <= SOURCE_DURATION_TOLERANCE_SECONDS || selectedBrowserEof);
  const effectiveEnd = withinSource ? Math.min(requestedEnd, duration) : NaN;
  const clipDuration = effectiveEnd - start;
  return {
    valid: withinSource && clipDuration > 0 && clipDuration <= MAX_CLIP_SECONDS + 0.001
      && requestedEnd - start <= MAX_CLIP_SECONDS + 0.001,
    effectiveEnd,
    clipDuration,
    endDelta,
  };
};

const validateSignRequest = ({ mimeType, fileSize, trimStart, trimEnd, clientVideoDuration, idempotencyKey, presentation = 'post', cropMode = 'cover', coverTime }) => {
  const start = Number(trimStart);
  const end = Number(trimEnd);
  const size = Number(fileSize);
  const browserDuration = clientVideoDuration === undefined ? undefined : Number(clientVideoDuration);
  if (!ALLOWED_MIME_FORMATS[mimeType]) throw httpError(415, 'Choose an MP4, WebM, or MOV video.', 'unsupported_format');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_BYTES) throw httpError(413, 'Videos must be smaller than 250MB.', 'file_too_large');
  // Trim positions are absolute offsets into the source video. A 30-second
  // selection beginning at 40s is valid; only its duration must be <= 35s.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > MAX_CLIP_SECONDS + 0.001) {
    throw httpError(400, 'Choose a valid video clip that is 35 seconds or shorter.', 'invalid_trim');
  }
  if (browserDuration !== undefined && (!Number.isFinite(browserDuration) || browserDuration <= 0)) {
    throw httpError(400, 'The selected video duration is not ready yet. Wait for the preview duration, then retry.', 'invalid_video_duration');
  }
  if (browserDuration !== undefined && end - browserDuration > 0.05) {
    throw httpError(400, 'The selected trim end is beyond the browser-detected source duration.', 'invalid_trim');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) {
    throw httpError(400, 'The upload could not be started. Please retry.', 'invalid_request');
  }
  const cover = coverTime === undefined ? start : Number(coverTime);
  if (!['post', 'reel'].includes(presentation) || !['cover', 'fit'].includes(cropMode) || !Number.isFinite(cover) || cover < start || cover > end) {
    throw httpError(400, 'Choose a valid Reel layout and cover frame.', 'invalid_presentation');
  }
  return { mimeType, fileSize: size, trimStart: start, trimEnd: end, clientVideoDuration: browserDuration, idempotencyKey, presentation, cropMode, coverTime: cover };
};

const signUpload = async (req, res, next) => {
  const startedAt = Date.now();
  let declaredBytes;
  try {
    if (!req.user?._id) throw httpError(401, 'Sign in to publish a video.', 'unauthorized');
    if (!isCloudinaryConfigured()) throw httpError(503, 'Video publishing is temporarily unavailable. Cloud storage is not configured.', 'storage_unavailable');
    const input = validateSignRequest(req.body || {});
    declaredBytes = input.fileSize;
    console.info('[video-upload] client-trim-selection', JSON.stringify({ videoDurationSeconds: Number(req.body?.clientVideoDuration), trimStartSeconds: input.trimStart, trimEndSeconds: input.trimEnd, uploadedAssetIsFullSource: true }));

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
        clientVideoDuration: input.clientVideoDuration,
        presentation: input.presentation,
        cropMode: input.cropMode,
        coverTime: input.coverTime,
        declaredBytes: input.fileSize,
        mimeType: input.mimeType,
        authorizationIssuedAt: new Date(),
        cleanupAfter: new Date(Date.now() + CLEANUP_AFTER_MS),
      });
    } else if (session.declaredBytes !== input.fileSize || session.mimeType !== input.mimeType || session.trimStart !== input.trimStart || session.trimEnd !== input.trimEnd || (session.clientVideoDuration != null && input.clientVideoDuration != null && session.clientVideoDuration !== input.clientVideoDuration) || (session.presentation || 'post') !== input.presentation || (session.cropMode || 'cover') !== input.cropMode || (session.coverTime ?? session.trimStart) !== input.coverTime) {
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
    // The database session is already scoped to the authenticated user and
    // contains a server-generated, unique Cloudinary public ID. Context is
    // useful defense-in-depth, but some provider responses omit custom context
    // even when the asset lookup succeeds. Require it to match only when claims
    // are returned; never let absent optional metadata reject a valid upload.
    const publicIdMatches = resource.public_id === session.publicId;
    const hasOwnershipContext = Object.hasOwn(context, 'user_id') || Object.hasOwn(context, 'upload_session');
    const ownershipContextMatches = !hasOwnershipContext || (
      context.user_id === String(req.user._id)
      && context.upload_session === String(session._id)
    );
    const isOwned = publicIdMatches && ownershipContextMatches;
    const validFormat = formats?.includes(String(resource.format || '').toLowerCase());
    const clientVideoDuration = session.clientVideoDuration ?? Number(req.body?.clientVideoDuration);
    const trimResolution = resolveTrimAgainstSource(sourceDuration, session.trimStart, session.trimEnd, clientVideoDuration);
    const effectiveTrimEnd = trimResolution.effectiveEnd;
    const effectiveClipDuration = trimResolution.clipDuration;
    const validDuration = trimResolution.valid;
    console.info('[video-upload] trim-duration-verification', JSON.stringify({ clientVideoDurationSeconds: Number.isFinite(clientVideoDuration) ? clientVideoDuration : null, cloudinarySourceDurationSeconds: sourceDuration, trimStartSeconds: session.trimStart, requestedTrimEndSeconds: session.trimEnd, effectiveTrimEndSeconds: effectiveTrimEnd, effectiveClipDurationSeconds: effectiveClipDuration, endDeltaSeconds: session.trimEnd - sourceDuration, selectedBrowserEof: Number.isFinite(clientVideoDuration) && Math.abs(session.trimEnd - clientVideoDuration) <= TRIM_SLIDER_STEP_SECONDS + Number.EPSILON * Math.max(1, Math.abs(session.trimEnd), Math.abs(clientVideoDuration)) * 4, sourceDurationToleranceSeconds: SOURCE_DURATION_TOLERANCE_SECONDS, fullSourceUploaded: true, trimAppliedAsDeliveryTransform: true }));
    if (resource.resource_type !== 'video' || !isOwned || !validFormat || !Number.isFinite(resourceBytes) || resourceBytes <= 0 || resourceBytes > MAX_VIDEO_BYTES || !validDuration) {
      console.warn('[video-upload] provider-asset-rejected', JSON.stringify({
        resourceTypeValid: resource.resource_type === 'video',
        publicIdMatches,
        ownershipContextPresent: hasOwnershipContext,
        ownershipContextMatches,
        formatValid: validFormat,
        bytesValid: Number.isFinite(resourceBytes) && resourceBytes > 0 && resourceBytes <= MAX_VIDEO_BYTES,
        durationValid: validDuration,
        sourceDuration,
        requestedClipEnd: session.trimEnd,
      }));
      session.status = 'rejected';
      await session.save();
      await cloudinary.uploader.destroy(session.publicId, { resource_type: 'video', invalidate: true }).catch(() => {});
      const reason = resourceBytes > MAX_VIDEO_BYTES
        ? 'The uploaded video exceeds the 250MB limit.'
        : !publicIdMatches || !ownershipContextMatches
          ? 'Cloud storage returned ownership details that do not match this upload.'
          : !validFormat
            ? 'Cloud storage reported an unsupported video format.'
            : !validDuration
              ? 'The selected trim range extends beyond the detected video duration. Adjust the trim and retry.'
              : 'The uploaded video could not be verified. Retry with the same selected video.';
      throw httpError(400, reason, 'video_validation_failed');
    }

    const contentText = content.trim();
    const tags = [...new Set((contentText.match(/#[a-zA-Z0-9_]+/g) || []).map((tag) => tag.slice(1).toLowerCase()))];
    const actualCoverTime = Math.max(session.trimStart, Math.min(session.coverTime ?? session.trimStart, effectiveTrimEnd - 0.01));
    const { videoUrl, videoThumbnail } = makeVideoUrls(session.publicId, session.trimStart, effectiveTrimEnd, session.presentation, session.cropMode, actualCoverTime);
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
        videoDuration: effectiveClipDuration,
        videoPresentation: session.presentation,
        videoCropMode: session.cropMode,
        videoCoverTime: actualCoverTime,
        videoTrimStart: session.trimStart,
        videoTrimEnd: effectiveTrimEnd,
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

module.exports = { signUpload, publishUploadedVideo, cleanupAbandonedVideoUploads, validateSignRequest, resolveTrimAgainstSource, makeVideoUrls, MAX_VIDEO_BYTES, MAX_CLIP_SECONDS };
