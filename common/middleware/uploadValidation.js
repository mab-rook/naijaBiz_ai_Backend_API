const fs = require('fs');
const AppError = require('../utils/AppError');

const UPLOAD_TYPES = {
  audio: {
    'audio/mp4': { extension: '.m4a', signature: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
    'audio/aac': { extension: '.aac', signature: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
    'audio/mpeg': { extension: '.mp3', signature: (b) => b.toString('ascii', 0, 3) === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
    'audio/wav': { extension: '.wav', signature: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
    'audio/x-wav': { extension: '.wav', signature: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
    'audio/ogg': { extension: '.ogg', signature: (b) => b.toString('ascii', 0, 4) === 'OggS' },
    'audio/webm': { extension: '.webm', signature: (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  },
  image: {
    'image/jpeg': { extension: '.jpg', signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    'image/png': { extension: '.png', signature: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    'image/webp': { extension: '.webp', signature: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  },
};

const getUploadType = (kind, mimetype) => UPLOAD_TYPES[kind][mimetype];

const fileFilter = (kind) => (req, file, callback) => {
  if (!getUploadType(kind, file.mimetype)) {
    return callback(new AppError(400, `Unsupported ${kind} file type`, 'UNSUPPORTED_UPLOAD_TYPE'));
  }
  return callback(null, true);
};

const validateUploadedFile = (kind) => async (req, res, next) => {
  if (!req.file) return next();
  try {
    const type = getUploadType(kind, req.file.mimetype);
    const handle = await fs.promises.open(req.file.path, 'r');
    const header = Buffer.alloc(16);
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(header, 0, header.length, 0));
    } finally {
      await handle.close();
    }

    if (!type.signature(header.subarray(0, bytesRead))) {
      throw new AppError(400, `File content does not match the declared ${kind} type`, 'INVALID_UPLOAD_CONTENT');
    }

    req.file.extension = type.extension;
    req.file.originalname = `upload${type.extension}`;
    return next();
  } catch (error) {
    return next(error);
  }
};

const cleanupRejectedUpload = (err, req, res, next) => {
  if (!req.file || !req.file.path) return next(err);
  fs.promises.unlink(req.file.path).then(
    () => next(err),
    (cleanupError) => {
      if (cleanupError.code === 'ENOENT') return next(err);
      return next(cleanupError);
    }
  );
};

module.exports = { fileFilter, getUploadType, validateUploadedFile, cleanupRejectedUpload };
