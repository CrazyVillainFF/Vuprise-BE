const notFound = (req, res, next) => {
  const error = new Error(`Resource not found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
  let message = err.message;

  // Mongoose bad ObjectId
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    statusCode = 404;
    message = 'Resource not found with the requested ID';
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    statusCode = 400;
    const field = Object.keys(err.keyValue)[0];
    message = `An account with this ${field} already exists. Please use a different ${field} or sign in.`;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors).map(val => val.message).join(', ');
  }
  if (err.name === 'VersionError') { statusCode = 409; message = 'This record changed while you were editing it. Refresh and try again.'; }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 413;
    message = req.originalUrl?.startsWith('/api/support/')
      ? 'Each evidence photo must be 5 MB or smaller.'
      : req.originalUrl?.startsWith('/api/admin/messages/broadcast')
        ? 'Official message images must be 5 MB or smaller.'
        : 'The uploaded image is too large. Images are limited to 10MB; publish videos through the direct video upload flow.';
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
    statusCode = 400;
    message = req.originalUrl?.startsWith('/api/support/')
      ? 'Attach up to 5 evidence photos.'
      : req.originalUrl?.startsWith('/api/admin/messages/broadcast')
        ? 'Attach one image per official message.'
        : 'Upload one image per post. Videos use the secure direct-upload flow.';
  }

  console.error(`[Error ${statusCode}] ${req.method} ${req.originalUrl}:`, err.message);

  // Unexpected server faults keep a generic message in production so internal
  // details (database hosts, provider responses, stack context) are not exposed.
  if (process.env.NODE_ENV === 'production' && statusCode >= 500) {
    message = 'Something went wrong on the server. Please try again later.';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = { notFound, errorHandler };
