const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const cloudinary = require('cloudinary').v2;

// Ensure local uploads directory exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Setup Cloudinary if credentials provided
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
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
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${file.fieldname}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 250 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const imageTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'image/gif'];
    const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
    if (file.fieldname === 'image' && imageTypes.includes(file.mimetype)) return cb(null, true);
    if (file.fieldname === 'video' && videoTypes.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Choose a supported image or video file.'));
  }
});

const preparePostUpload = (req, res, next) => {
  const images = req.files?.image || [];
  const videos = req.files?.video || [];
  if (images.length + videos.length > 1) {
    [...images, ...videos].forEach((file) => fs.unlink(file.path, () => {}));
    return res.status(400).json({ success: false, message: 'Upload one image or one video per post.' });
  }
  req.file = images[0] || videos[0] || null;
  if (req.file?.fieldname === 'image' && req.file.size > 10 * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: 'Image size exceeds 10MB.' });
  }
  return next();
};

/**
 * Upload helper that processes the uploaded file:
 * Uploads to Cloudinary if configured; otherwise returns the static local URL.
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
  const resourceType = isVideo ? 'video' : 'image';
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: `nexora/${folder}`,
      resource_type: resourceType,
      ...(isVideo ? { eager: [{ format: 'jpg', transformation: [{ width: 640, crop: 'limit' }] }] } : {})
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
