const mongoose = require('mongoose');
const crypto = require('crypto');

const refreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  familyId: { type: String, required: true, default: () => crypto.randomBytes(16).toString('hex'), index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expiresAt: { type: Date, required: true },
  revoked: { type: Boolean, default: false },
  replacedByHash: { type: String, default: null },
  userAgent: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

// TTL index: MongoDB auto-deletes expired documents
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.statics.hashToken = (raw) =>
  crypto.createHash('sha256').update(raw).digest('hex');

refreshTokenSchema.statics.generate = () =>
  crypto.randomBytes(40).toString('hex');

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
