const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Single place for JWT signing / verification.
 * Tokens are HS256, carry the user id in `sub`, and are pinned to this API's issuer/audience.
 */

const ALGORITHM = 'HS256';
const ISSUER = 'naijabiz-api';
const AUDIENCE = 'naijabiz-app';
const MIN_SECRET_LENGTH = 32;

let devSecret = null;

const isProduction = () => process.env.NODE_ENV === 'production';

const getSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (isProduction()) {
    throw new Error('JWT_SECRET must be set in production');
  }
  // Development/test only: random per-process secret (tokens stop working after a restart)
  if (!devSecret) {
    devSecret = crypto.randomBytes(48).toString('hex');
    console.warn('[auth] JWT_SECRET is not set; using a temporary random secret for this process.');
  }
  return devSecret;
};

const getExpiresIn = () => process.env.JWT_EXPIRES_IN || '7d';

const getRefreshExpiresIn = () => process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';

const parseExpiresIn = (str) => {
  const match = String(str).match(/^(\d+)([smhd])$/);
  if (!match) return parseInt(str, 10) || 0;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 60 * 60 * 1000;
    case 'd': return val * 24 * 60 * 60 * 1000;
    default: return val;
  }
};

/** Fail fast on startup instead of on the first login */
const assertJwtConfig = () => {
  const secret = getSecret();
  if (isProduction() && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production`);
  }
};

const signToken = (user) =>
  jwt.sign(
    {
      businessId: user.business ? String(user.business._id || user.business) : null,
      tokenVersion: user.tokenVersion || 0,
    },
    getSecret(),
    {
      algorithm: ALGORITHM,
      expiresIn: getExpiresIn(),
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: String(user._id),
      jwtid: crypto.randomUUID(),
    }
  );

/** Returns the decoded payload; throws jsonwebtoken's TokenExpiredError / JsonWebTokenError */
const verifyToken = (token) =>
  jwt.verify(token, getSecret(), {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE,
  });

module.exports = {
  assertJwtConfig,
  signToken,
  verifyToken,
  getExpiresIn,
  getRefreshExpiresIn,
  parseExpiresIn,
};
