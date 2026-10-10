const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
const AppError = require('../../common/utils/AppError');

const hasCompleteCloudinaryCredentials = () =>
  Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

const hasValidCloudinaryUrl = () => {
  if (!process.env.CLOUDINARY_URL) return false;
  try {
    const url = new URL(process.env.CLOUDINARY_URL);
    return url.protocol === 'cloudinary:' && Boolean(url.hostname && url.username && url.password);
  } catch {
    return false;
  }
};

const isCloudinaryConfigured = () =>
  hasCompleteCloudinaryCredentials() || hasValidCloudinaryUrl();

const cloudinaryClient = () => {
  if (hasCompleteCloudinaryCredentials()) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  } else if (hasValidCloudinaryUrl()) {
    cloudinary.config(true);
  } else {
    throw new AppError(503, 'Private Cloudinary storage is not configured', 'MEDIA_STORAGE_UNAVAILABLE');
  }
  return cloudinary;
};

const storeUpload = async (file, businessId) => {
  if (!file) return null;
  const resourceType = file.mimetype.startsWith('audio/') ? 'video' : 'image';

  if (!isCloudinaryConfigured()) {
    const anyCloudConfig = [
      process.env.CLOUDINARY_CLOUD_NAME,
      process.env.CLOUDINARY_API_KEY,
      process.env.CLOUDINARY_API_SECRET,
      process.env.CLOUDINARY_URL,
    ].some(Boolean);
    if (anyCloudConfig || process.env.NODE_ENV === 'production') {
      throw new AppError(503, 'Private Cloudinary storage is not configured', 'MEDIA_STORAGE_UNAVAILABLE');
    }
    return {
      provider: 'local',
      fileName: path.basename(file.path),
      resourceType,
      format: file.extension.slice(1),
      mimeType: file.mimetype,
      bytes: file.size,
    };
  }

  const result = await cloudinaryClient().uploader.upload(file.path, {
    resource_type: resourceType,
    type: 'authenticated',
    public_id: `naijabiz/${businessId}/${crypto.randomUUID()}`,
    overwrite: false,
    use_filename: false,
    unique_filename: false,
    access_mode: 'authenticated',
  });

  await fs.promises.unlink(file.path);
  return {
    provider: 'cloudinary',
    publicId: result.public_id,
    resourceType: result.resource_type,
    format: result.format,
    mimeType: file.mimetype,
    bytes: result.bytes,
  };
};

const deleteUpload = async (media) => {
  if (!media) return;
  if (media.provider === 'cloudinary') {
    await cloudinaryClient().uploader.destroy(media.publicId, {
      resource_type: media.resourceType,
      type: 'authenticated',
      invalidate: true,
    });
    return;
  }
  if (media.provider === 'local' && media.fileName) {
    const uploadDir = path.resolve(__dirname, '../../uploads');
    const filePath = path.resolve(uploadDir, media.fileName);
    if (path.dirname(filePath) !== uploadDir) {
      throw new AppError(500, 'Invalid local media path', 'MEDIA_PATH_INVALID');
    }
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
};

const getCloudinaryDeliveryUrl = (media) => {
  if (!isCloudinaryConfigured()) {
    throw new AppError(503, 'Private Cloudinary storage is not configured', 'MEDIA_STORAGE_UNAVAILABLE');
  }
  return cloudinaryClient().url(media.publicId, {
    secure: true,
    sign_url: true,
    type: 'authenticated',
    resource_type: media.resourceType,
    format: media.format,
  });
};

module.exports = {
  isCloudinaryConfigured,
  storeUpload,
  deleteUpload,
  getCloudinaryDeliveryUrl,
};
