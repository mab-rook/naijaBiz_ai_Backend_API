/**
 * Mongo-backed fixed-window limiter. Atomic counters are shared by every API instance.
 */
const crypto = require('crypto');
const RateLimitCounter = require('../models/rateLimitCounterModel');
const AppError = require('../utils/AppError');

const createRateLimiter = ({ name, windowMs, max, keyFn = (req) => req.ip, message }) => {
  const limiter = async (req, res, next) => {
    try {
      await initializeRateLimiterStore();
      const key = keyFn(req);
      if (!key) return next();

      const now = Date.now();
      const windowStartMs = Math.floor(now / windowMs) * windowMs;
      const windowStart = new Date(windowStartMs);
      const resetAt = new Date(windowStartMs + windowMs);
      const keyHash = crypto.createHash('sha256').update(String(key)).digest('hex');
      const bucketId = `${name}:${keyHash}:${windowStartMs}`;
      const counter = await RateLimitCounter.findOneAndUpdate(
        { _id: bucketId },
        {
          $inc: { count: 1 },
          $setOnInsert: {
            limiterName: name,
            keyHash,
            windowStart,
            expiresAt: new Date(resetAt.getTime() + windowMs),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: false }
      );

      const limit = typeof max === 'function' ? max() : max;
      const retryAfterSec = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000));
      res.set('RateLimit-Limit', String(limit));
      res.set('RateLimit-Remaining', String(Math.max(0, limit - counter.count)));

      if (counter.count > limit) {
        res.set('Retry-After', String(retryAfterSec));
        console.warn(`[rate-limit] ${name} blocked keyHash=${keyHash.slice(0, 12)}`);
        return res.status(429).json({
          success: false,
          code: 'RATE_LIMITED',
          message: message || `Too many requests. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
          retryAfterSeconds: retryAfterSec,
        });
      }
      return next();
    } catch (err) {
      console.error(`[rate-limit] ${name} shared counter failed: ${err.message}`);
      return next(new AppError(503, 'Rate limiting is temporarily unavailable. Please try again.', 'RATE_LIMIT_UNAVAILABLE'));
    }
  };

  limiter.reset = () => RateLimitCounter.deleteMany({ limiterName: name });
  return limiter;
};

let indexCreation;
const initializeRateLimiterStore = () => {
  if (!indexCreation) {
    indexCreation = RateLimitCounter.collection
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch((err) => {
        indexCreation = null;
        throw err;
      });
  }
  return indexCreation;
};

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const envNumber = (name, fallback) => Number(process.env[name]) || fallback;

// Brute-force protection: per IP, and per phone number (so rotating IPs doesn't help)
const loginLimiterByIp = createRateLimiter({
  name: 'login-ip',
  windowMs: FIFTEEN_MINUTES,
  max: () => envNumber('LOGIN_RATE_LIMIT_PER_IP', 30),
  message: 'Too many login attempts from this device. Please wait 15 minutes and try again.',
});

const loginLimiterByPhone = createRateLimiter({
  name: 'login-phone',
  windowMs: FIFTEEN_MINUTES,
  max: () => envNumber('LOGIN_RATE_LIMIT_PER_PHONE', 10),
  keyFn: (req) => (req.body && req.body.phone ? `phone:${String(req.body.phone).trim()}` : null),
  message: 'Too many login attempts for this phone number. Please wait 15 minutes and try again.',
});

const registerLimiter = createRateLimiter({
  name: 'register-ip',
  windowMs: 60 * 60 * 1000,
  max: () => envNumber('REGISTER_RATE_LIMIT_PER_IP', 10),
  message: 'Too many accounts created from this device. Please try again later.',
});

module.exports = {
  createRateLimiter,
  initializeRateLimiterStore,
  loginLimiterByIp,
  loginLimiterByPhone,
  registerLimiter,
};
