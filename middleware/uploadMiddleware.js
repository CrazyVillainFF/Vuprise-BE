const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cloudinary = require('../config/cloudinary');

// Ensure local uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer disk storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

// File filter for image types only
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/gif'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const error = new Error('Only image files (JPEG, PNG, WEBP, GIF) are allowed.');
    error.statusCode = 415;
    cb(error, false);
  }
};

const detectImageType = (filePath) => {
  const signature = Buffer.alloc(12);
  const descriptor = fs.openSync(filePath, 'r');
  try { fs.readSync(descriptor, signature, 0, signature.length, 0); }
  finally { fs.closeSync(descriptor); }
  if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) return 'jpeg';
  if (signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a$/.test(signature.subarray(0, 6).toString('ascii'))) return 'gif';
  if (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
};

// Server-side content check. Declared MIME types and filenames are never
// trusted on their own: the stored bytes must carry a supported image header.
const imageContentValidator = ({
  allowed = ['jpeg', 'png', 'gif', 'webp'],
  message = 'The uploaded file is not a valid JPEG, PNG, WEBP, or GIF image.'
} = {}) => (req, res, next) => {
  const files = [...(req.files || []), ...(req.file ? [req.file] : [])];
  if (!files.length) return next();
  for (const file of files) {
    if (file.mimetype?.startsWith('video/')) continue;
    let detected = null;
    try { detected = detectImageType(file.path); } catch { detected = null; }

    if (!detected || !allowed.includes(detected)) {
      files.forEach((uploaded) => fs.unlink(uploaded.path, () => {}));
      return res.status(400).json({ success: false, message });
    }
  }
  return next();
};

const validateImageContent = imageContentValidator();

const validateBroadcastImage = imageContentValidator({
  allowed: ['jpeg', 'png', 'webp'],
  message: 'The uploaded file is not a valid JPG, PNG, or WebP image.'
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter
});

// Official Vuprise messages only accept one JPG/PNG/WebP attachment (5MB).
const broadcastUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (imageTypes.includes(file.mimetype)) return cb(null, true);
    const error = new Error('Official message attachments must be JPG, PNG, or WebP images.');
    error.statusCode = 415;
    return cb(error);
  }
});

const discardUploadedFile = async (file) => {
  if (file?.path) await fs.promises.unlink(file.path).catch(() => {});
};

const supportUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter
});

// Vuprise AI attachments: JPG/PNG/WEBP only, 5MB each, up to 4 per message.
const aiUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) => {
    const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (imageTypes.includes(file.mimetype)) return cb(null, true);
    const error = new Error('Attachments must be JPG, PNG, or WebP images.');
    error.statusCode = 415;
    return cb(error);
  }
});

const validateAiImageContent = imageContentValidator({
  allowed: ['jpeg', 'png', 'webp'],
  message: 'Attachments must be valid JPG, PNG, or WebP images (up to 5MB each, 4 per message).'
});

// Multer errors (size, count, field) become clean 400/413 responses instead of
// reaching the generic error middleware.
const aiAttachmentUpload = (req, res, next) => {
  aiUpload.array('images', 4)(req, res, (error) => {
    if (!error) return next();
    const files = [...(req.files || [])];
    files.forEach((file) => fs.unlink(file.path, () => {}));
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'Each attachment must be 5MB or smaller.' });
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ success: false, message: 'Attach up to 4 images per message.' });
    return res.status(error.statusCode || 400).json({ success: false, message: error.message || 'The attachment could not be uploaded.' });
  });
};

const postUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const imageTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/gif'];
    if (file.fieldname === 'image' && imageTypes.includes(file.mimetype)) return cb(null, true);
    const error = new Error('Video bytes must be uploaded directly to cloud storage. Choose a supported image file here.');
    error.statusCode = 415;
    return cb(error);
  }
});

const preparePostUpload = (req, res, next) => {
  const images = req.files?.image || [];
  if (images.length > 1) {
    images.forEach((file) => fs.unlink(file.path, () => {}));
    return res.status(400).json({ success: false, message: 'Upload one image per post.' });
  }
  req.file = req.file || images[0] || null;
  if (req.file?.size > 10 * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: 'Image size exceeds 10MB.' });
  }
  return next();
};

/**
 * Upload helper that processes the uploaded file:
 * Uploads an image to Cloudinary if configured; otherwise returns the static local URL.
 */
const processUploadedFile = async (file, req, folder = 'nexora') => {
  if (!file) return null;

  // If Cloudinary is configured
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    try {
      const result = await cloudinary.uploader.upload(file.path, {
        folder: `nexora/${folder}`,
        resource_type: file.mimetype?.startsWith('video/') ? 'video' : 'image'
      });
      // Remove temporary local file after Cloudinary upload
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      return result.secure_url;
    } catch (err) {
      console.error('[Cloudinary Upload Error]', err);
      // Fallback to local file URL if Cloudinary fails
    }
  }

  // Local storage URL (served statically via Express /uploads route)
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/uploads/${file.filename}`;
};

const processUploadedMedia = async (file, req, folder = 'nexora') => {
  if (!file) return null;
  const isVideo = file.mimetype?.startsWith('video/');
  if (isVideo) {
    await fs.promises.unlink(file.path).catch(() => {});
    const error = new Error('Videos must use the secure direct-upload flow.');
    error.statusCode = 415;
    throw error;
  }
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: `nexora/${folder}`,
      resource_type: 'image'
    });
    fs.unlink(file.path, () => {});
    return { url: result.secure_url, publicId: result.public_id, thumbnail: result.eager?.[0]?.secure_url || '' };
  }
  let filename = file.filename;
  if (!path.resolve(file.path).startsWith(`${path.resolve(uploadDir)}${path.sep}`)) {
    filename = `media-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${path.extname(file.path) || (isVideo ? '.mp4' : '.jpg')}`;
    const storedPath = path.join(uploadDir, filename);
    await fs.promises.copyFile(file.path, storedPath);
    await fs.promises.unlink(file.path).catch(() => {});
  }
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return { url: `${baseUrl}/uploads/${filename}`, publicId: '', thumbnail: '' };
};

const deleteUploadedMedia = async ({ publicId, url, resourceType = 'image' } = {}) => {
  if (publicId && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return;
  }
  if (url && url.includes('/uploads/')) {
    const filename = path.basename(new URL(url).pathname);
    if (filename) await fs.promises.unlink(path.join(uploadDir, filename)).catch(() => {});
  }
};

module.exports = { upload, supportUpload, postUpload, broadcastUpload, preparePostUpload, processUploadedFile, processUploadedMedia, deleteUploadedMedia, detectImageType, validateImageContent, validateBroadcastImage, discardUploadedFile, aiAttachmentUpload, validateAiImageContent };
