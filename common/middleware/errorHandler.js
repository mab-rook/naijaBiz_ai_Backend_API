const errorHandler = (err, req, res, next) => {
  // Expected errors (AppError) are logged briefly; anything else is a bug and gets the full stack
  if (err.name === 'AppError') {
    console.warn(`[${err.statusCode}] ${req.method} ${req.originalUrl}: ${err.message}`);
  } else {
    console.error('Error occurred:', err);
  }

  let statusCode = err.name === 'AppError'
    ? err.statusCode
    : err.name === 'ValidationError' || err.name === 'MulterError' || err.code === 11000
      ? 400
      : err.name === 'CastError'
        ? 404
        : 500;
  let message = err.name === 'AppError' ? err.message : 'Internal Server Error';
  const code = err.name === 'AppError' ? err.code : undefined;

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((val) => val.message)
      .join(', ');
  }

  if (err.name === 'MulterError') {
    statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Uploaded file exceeds the 10 MB limit'
      : 'Invalid upload request';
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    statusCode = 400;
    message = `Duplicate field value entered: ${Object.keys(err.keyValue).join(', ')}`;
  }

  // Mongoose bad ObjectId CastError
  if (err.name === 'CastError') {
    statusCode = 404;
    message = `Resource not found with id of ${err.value}`;
  }

  const exposeDetails = err.name === 'AppError' || statusCode < 500;
  res.status(statusCode).json({
    success: false,
    code,
    message: exposeDetails ? message : 'Internal Server Error',
    stack: !exposeDetails && process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  });
};

module.exports = errorHandler;
