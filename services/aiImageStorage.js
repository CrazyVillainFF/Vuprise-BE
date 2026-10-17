const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cloudinary = require('../config/cloudinary');
const { AiChatError } = require('./aiChatService');

const uploadDir = path.join(__dirname, '../uploads');

// Mirrors the project's existing upload middleware: Cloudinary when configured,
// otherwise the locally served /uploads directory. Only the resulting URL is
// ever persisted in MongoDB - base64 image data never enters chat history.
const cloudinaryConfigured = () => Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

const uploadBufferToCloudinary = (buffer, folder) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream({ folder: `nexora/${folder}`, resource_type: 'image' }, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
  stream.end(buffer);
});

const extensionForMime = (mime) => {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  return '.png';
};

const persistGeneratedImage = async ({ buffer, mime = 'image/png', baseUrl = '' }) => {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AiChatError('The image service returned an unexpected response.', 502, 'AI_IMAGE_BAD_RESPONSE');
  }
  if (cloudinaryConfigured()) {
    const result = await uploadBufferToCloudinary(buffer, 'ai-images');
    return { url: result.secure_url, publicId: result.public_id };
  }
  const filename = `ai-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extensionForMime(mime)}`;
  fs.mkdirSync(uploadDir, { recursive: true });
  await fs.promises.writeFile(path.join(uploadDir, filename), buffer);
  return { url: `${baseUrl}/uploads/${filename}`, publicId: '' };
};

module.exports = { persistGeneratedImage, cloudinaryConfigured };
