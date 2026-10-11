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
    cb(new Error('Only image files (JPEG, PNG, WEBP, GIF) are allowed.'), false);
  }
};

const validateImageContent = (req, res, next) => {
  if (!req.file) return next();
  if (req.file.mimetype?.startsWith('video/')) return next();
  let valid = false;
  try {
    const signature = Buffer.alloc(12);
    const descriptor = fs.openSync(req.file.path, 'r');
    try { fs.readSync(descriptor, signature, 0, signature.length, 0); }
    finally { fs.closeSync(descriptor); }
    const bytes = [...signature];
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isGif = signature.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/);
    const isWebp = signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP';
    valid = isJpeg || isPng || isGif || isWebp;
  } catch { valid = false; }

  if (!valid) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: 'The uploaded file is not a valid JPEG, PNG, WEBP, or GIF image.' });
  }
  return next();
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter
});

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

module.exports = { upload, postUpload, preparePostUpload, processUploadedFile, processUploadedMedia, deleteUploadedMedia, validateImageContent };
