const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('./userModel');
const Business = require('./businessModel');
const { verifyToken } = require('./tokenService');
const RevokedAccessToken = require('./revokedAccessTokenModel');

const unauthorized = (res, code, message) => res.status(401).json({ success: false, code, message });

// Opt-in shortcut for local demos: requests without a token act as the first (seeded) merchant.
// Never active in production, whatever DEMO_MODE says.
const isDemoMode = () => process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';

const attachUser = (req, user) => {
  req.user = user;
  req.businessId = user.business ? user.business._id : null;
};

const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    const hasBearer = scheme === 'Bearer' && Boolean(token);

    if (!hasBearer) {
      if (!header && isDemoMode()) {
        const demoUser = await User.findOne().sort({ createdAt: 1 }).populate('business');
        if (demoUser) {
          attachUser(req, demoUser);
          return next();
        }
      }
      return unauthorized(res, 'TOKEN_MISSING', 'Not authorized. Send the header "Authorization: Bearer <token>".');
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return unauthorized(res, 'TOKEN_EXPIRED', 'Your session has expired. Please log in again.');
      }
      return unauthorized(res, 'TOKEN_INVALID', 'Invalid token. Please log in again.');
    }

    if (!decoded.jti || typeof decoded.exp !== 'number') {
      return unauthorized(res, 'TOKEN_INVALID', 'Invalid token. Please log in again.');
    }
    if (await RevokedAccessToken.exists({ jti: decoded.jti })) {
      return unauthorized(res, 'TOKEN_REVOKED', 'This session has been logged out. Please log in again.');
    }

    const user = await User.findById(decoded.sub).populate('business');
    if (!user) {
      return unauthorized(res, 'USER_NOT_FOUND', 'The user belonging to this token no longer exists.');
    }
    if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return unauthorized(res, 'TOKEN_REVOKED', 'This session has been logged out. Please log in again.');
    }
    if (!user.business) {
      return res.status(403).json({
        success: false,
        code: 'NO_BUSINESS',
        message: 'This account has no business profile.',
      });
    }

    attachUser(req, user);
    req.authToken = { jti: decoded.jti, expiresAt: new Date(decoded.exp * 1000) };
    next();
  } catch (err) {
    next(err);
  }
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * For read-only data endpoints the ML service calls (reports): accept either a merchant JWT,
 * or the shared INTERNAL_SERVICE_API_KEY in "X-API-Key" plus the business in "X-Business-Id".
 */
const protectUserOrService = async (req, res, next) => {
  const apiKey = req.get('X-API-Key');
  if (!apiKey) return protect(req, res, next);

  try {
    const expected = process.env.INTERNAL_SERVICE_API_KEY;
    if (!expected || !safeEqual(apiKey, expected)) {
      return unauthorized(res, 'SERVICE_KEY_INVALID', 'Invalid service API key.');
    }
    const businessId = req.get('X-Business-Id');
    if (!mongoose.isValidObjectId(businessId)) {
      return res.status(400).json({ success: false, code: 'BUSINESS_ID_REQUIRED', message: 'Send the business id in the "X-Business-Id" header.' });
    }
    const business = await Business.findById(businessId).select('_id');
    if (!business) {
      return res.status(404).json({ success: false, code: 'BUSINESS_NOT_FOUND', message: 'Business not found.' });
    }
    req.businessId = business._id;
    req.isService = true;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { protect, protectUserOrService };
