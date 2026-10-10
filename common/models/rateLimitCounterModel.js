const mongoose = require('mongoose');

const rateLimitCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    limiterName: { type: String, required: true },
    keyHash: { type: String, required: true },
    windowStart: { type: Date, required: true },
    count: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  {
    versionKey: false,
    collection: 'rate_limit_counters',
  }
);

module.exports = mongoose.models.RateLimitCounter
  || mongoose.model('RateLimitCounter', rateLimitCounterSchema);
