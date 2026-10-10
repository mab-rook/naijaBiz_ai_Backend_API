const mongoose = require('mongoose');
const AppError = require('./AppError');

/**
 * Reusable validation helpers.
 * Throw AppError on failure so the error handler returns a clean 400.
 */

const requireField = (value, name) => {
  if (value === undefined || value === null || value === '') {
    throw new AppError(400, `${name} is required`, 'VALIDATION_ERROR');
  }
};

const requirePositiveNumber = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(400, `${name} must be a positive number`, 'INVALID_AMOUNT');
  }
  return n;
};

const requireNonNegativeNumber = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new AppError(400, `${name} must be a non-negative number`, 'INVALID_AMOUNT');
  }
  return n;
};

const requireObjectId = (value, name) => {
  if (!value || !mongoose.isValidObjectId(value)) {
    throw new AppError(400, `${name} must be a valid ID`, 'VALIDATION_ERROR');
  }
};

const requireString = (value, name, { maxLength = 500 } = {}) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, `${name} must be a non-empty string`, 'VALIDATION_ERROR');
  }
  if (value.length > maxLength) {
    throw new AppError(400, `${name} must be at most ${maxLength} characters`, 'VALIDATION_ERROR');
  }
  return value.trim();
};

const optionalString = (value, name, { maxLength = 500 } = {}) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new AppError(400, `${name} must be a string`, 'VALIDATION_ERROR');
  }
  if (value.length > maxLength) {
    throw new AppError(400, `${name} must be at most ${maxLength} characters`, 'VALIDATION_ERROR');
  }
  return value.trim();
};

const requireEnum = (value, name, allowed) => {
  if (!allowed.includes(value)) {
    throw new AppError(400, `${name} must be one of: ${allowed.join(', ')}`, 'VALIDATION_ERROR');
  }
};

const requireArray = (value, name) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, `${name} must be a non-empty array`, 'VALIDATION_ERROR');
  }
};

const optionalDate = (value, name) => {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new AppError(400, `${name} has an invalid date format`, 'VALIDATION_ERROR');
  }
  return d;
};

module.exports = {
  requireField,
  requirePositiveNumber,
  requireNonNegativeNumber,
  requireObjectId,
  requireString,
  optionalString,
  requireEnum,
  requireArray,
  optionalDate,
};
