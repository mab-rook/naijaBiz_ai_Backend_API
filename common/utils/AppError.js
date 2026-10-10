/**
 * Error with an HTTP status and a machine-readable code.
 * Throw it from services; common/middleware/errorHandler.js turns it into the response.
 */
class AppError extends Error {
  constructor(statusCode, message, code = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

module.exports = AppError;
