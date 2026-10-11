const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAX_VIDEO_SECONDS = 35;
const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = () => process.env.FFPROBE_PATH || 'ffprobe';

const getClipRange = (sourceDuration, requestedStart = 0, requestedEnd) => {
  const start = Number(requestedStart);
  const end = requestedEnd === undefined || requestedEnd === '' ? sourceDuration : Number(requestedEnd);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > sourceDuration + 0.001) {
    const error = new Error('Choose a valid start and end within the selected video.'); error.statusCode = 400; throw error;
  }
  const boundedEnd = Math.min(sourceDuration, end);
  const duration = boundedEnd - start;
  if (duration > MAX_VIDEO_SECONDS + 0.000001) {
    const error = new Error(`The selected clip is ${duration.toFixed(2)} seconds. Trim it to 35 seconds or less.`); error.statusCode = 400; throw error;
  }
  return { start, end: boundedEnd, duration };
};

const probeVideo = async (filePath) => {
  let result;
  try {
    ({ stdout: result } = await execFileAsync(ffprobePath(), [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'format=duration,format_name:stream=codec_type,width,height,duration', '-of', 'json', filePath,
    ], { timeout: 20000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      const missing = new Error('Video processing is not configured on this server. Install FFmpeg and ffprobe, or set FFMPEG_PATH and FFPROBE_PATH.');
      missing.statusCode = 503;
      throw missing;
    }
    const invalid = new Error('The video file is invalid or its duration could not be verified.');
    invalid.statusCode = 400;
    throw invalid;
  }
  let metadata;
  try { metadata = JSON.parse(result); } catch { metadata = null; }
  const duration = Number(metadata?.format?.duration || metadata?.streams?.[0]?.duration);
  const videoStream = metadata?.streams?.find((stream) => stream.codec_type === 'video');
  if (!Number.isFinite(duration) || duration <= 0 || !videoStream?.width || !videoStream?.height) {
    const error = new Error('The video file is invalid or its duration could not be verified.');
    error.statusCode = 400;
    throw error;
  }
  return { duration, width: videoStream.width, height: videoStream.height, format: metadata?.format?.format_name || '' };
};

const processVideoClip = async (filePath, requestedStart = 0, requestedEnd) => {
  const metadata = await probeVideo(filePath);
  const { start, end, duration: clipDuration } = getClipRange(metadata.duration, requestedStart, requestedEnd);

  const output = path.join(os.tmpdir(), `vuprise-clip-${crypto.randomBytes(12).toString('hex')}.mp4`);
  try {
    await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(3), '-i', filePath,
      '-t', clipDuration.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', output,
    ], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    const finalMetadata = await probeVideo(output);
    if (finalMetadata.duration > MAX_VIDEO_SECONDS + 0.001) {
      const error = new Error('The edited video exceeds the 35-second limit after processing. Please choose a slightly shorter clip.');
      error.statusCode = 400;
      throw error;
    }
    return { path: output, duration: finalMetadata.duration, sourceDuration: metadata.duration, start, end: start + finalMetadata.duration, width: finalMetadata.width, height: finalMetadata.height };
  } catch (error) {
    await fs.unlink(output).catch(() => {});
    throw error;
  }
};

module.exports = { MAX_VIDEO_SECONDS, getClipRange, probeVideo, processVideoClip };
