const User = require('./userModel');
const Business = require('./businessModel');
const { signToken, getExpiresIn, getRefreshExpiresIn, parseExpiresIn } = require('./tokenService');
const RefreshToken = require('./refreshTokenModel');
const RevokedAccessToken = require('./revokedAccessTokenModel');
const withTransaction = require('../../common/utils/withTransaction');

/**
 * Register user and create default business
 */
const register = async (req, res, next) => {
  try {
    const { name, phone, password, businessName, preferredLanguage, category } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, phone number, and password are required',
      });
    }

    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'A user with this phone number already exists',
      });
    }

    const rawRefresh = RefreshToken.generate();
    const refreshExpiresIn = getRefreshExpiresIn();
    const registration = await withTransaction(async (session) => {
      const [user] = await User.create([{
        name,
        phone,
        password,
        preferredLanguage: preferredLanguage || 'en',
      }], { session });

      const [business] = await Business.create([{
        name: businessName || `${name}'s Store`,
        owner: user._id,
        category: category || 'Provisions & Foodstuff',
        currency: 'NGN',
      }], { session });

      user.business = business._id;
      await user.save({ session });

      const token = signToken(user);
      await RefreshToken.create([{
        tokenHash: RefreshToken.hashToken(rawRefresh),
        userId: user._id,
        expiresAt: new Date(Date.now() + parseExpiresIn(refreshExpiresIn)),
        userAgent: req.get('User-Agent') || '',
      }], { session });

      return { user, business, token };
    });
    const { user, business, token } = registration;

    res.status(201).json({
      success: true,
      token,
      tokenType: 'Bearer',
      expiresIn: getExpiresIn(),
      refreshToken: rawRefresh,
      refreshExpiresIn,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        preferredLanguage: user.preferredLanguage,
        business: {
          id: business._id,
          name: business.name,
          category: business.category,
          currency: business.currency,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Login user
 */
const login = async (req, res, next) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone and password',
      });
    }

    const user = await User.findOne({ phone }).select('+password').populate('business');
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password',
      });
    }

    const token = signToken(user);

    const rawRefresh = RefreshToken.generate();
    const refreshExpiresIn = getRefreshExpiresIn();
    await RefreshToken.create({
      tokenHash: RefreshToken.hashToken(rawRefresh),
      userId: user._id,
      expiresAt: new Date(Date.now() + parseExpiresIn(refreshExpiresIn)),
      userAgent: req.get('User-Agent') || '',
    });

    res.json({
      success: true,
      token,
      tokenType: 'Bearer',
      expiresIn: getExpiresIn(),
      refreshToken: rawRefresh,
      refreshExpiresIn,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        preferredLanguage: user.preferredLanguage,
        business: user.business,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current profile
 */
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).populate('business');
    res.json({
      success: true,
      user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update preferred language (en, yo, ha, ig)
 */
const updateLanguage = async (req, res, next) => {
  try {
    const { language } = req.body;
    if (!['en', 'yo', 'ha', 'ig'].includes(language)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid language. Supported codes: en, yo, ha, ig',
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { preferredLanguage: language },
      { new: true }
    ).populate('business');

    res.json({
      success: true,
      message: `Preferred language updated to ${language}`,
      user,
    });
  } catch (error) {
    next(error);
  }
};

const refreshAccessToken = async (req, res, next) => {
  try {
    const { refreshToken: rawToken } = req.body;
    if (!rawToken) {
      return res.status(400).json({ success: false, code: 'REFRESH_TOKEN_REQUIRED', message: 'Refresh token is required' });
    }

    const hash = RefreshToken.hashToken(rawToken);
    const stored = await RefreshToken.findOne({ tokenHash: hash });

    if (!stored || stored.revoked) {
      if (stored && stored.revoked) {
        await RefreshToken.updateMany(
          stored.familyId ? { familyId: stored.familyId } : { userId: stored.userId },
          { $set: { revoked: true } }
        );
      }
      return res.status(401).json({ success: false, code: 'REFRESH_TOKEN_INVALID', message: 'Invalid or revoked refresh token. Please log in again.' });
    }

    if (stored.expiresAt < new Date()) {
      return res.status(401).json({ success: false, code: 'REFRESH_TOKEN_EXPIRED', message: 'Refresh token has expired. Please log in again.' });
    }

    const user = await User.findById(stored.userId).populate('business');
    if (!user) {
      return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: 'User no longer exists.' });
    }

    const newRaw = RefreshToken.generate();
    const newHash = RefreshToken.hashToken(newRaw);
    await RefreshToken.create({
      tokenHash: newHash,
      userId: user._id,
      familyId: stored.familyId,
      expiresAt: new Date(Date.now() + parseExpiresIn(getRefreshExpiresIn())),
      userAgent: req.get('User-Agent') || '',
    });

    const consumed = await RefreshToken.findOneAndUpdate(
      { _id: stored._id, revoked: false, expiresAt: { $gt: new Date() } },
      { $set: { revoked: true, replacedByHash: newHash } },
      { new: true }
    );
    if (!consumed) {
      await RefreshToken.deleteOne({ tokenHash: newHash });
      const latest = await RefreshToken.findById(stored._id).select('userId familyId revoked expiresAt');
      if (latest && latest.revoked) {
        await RefreshToken.updateMany(
          latest.familyId ? { familyId: latest.familyId } : { userId: latest.userId },
          { $set: { revoked: true } }
        );
        return res.status(401).json({
          success: false,
          code: 'REFRESH_TOKEN_INVALID',
          message: 'Invalid or revoked refresh token. Please log in again.',
        });
      }
      if (latest && latest.expiresAt <= new Date()) {
        return res.status(401).json({
          success: false,
          code: 'REFRESH_TOKEN_EXPIRED',
          message: 'Refresh token has expired. Please log in again.',
        });
      }
      return res.status(401).json({
        success: false,
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Invalid or revoked refresh token. Please log in again.',
      });
    }

    const accessToken = signToken(user);
    res.json({
      success: true,
      token: accessToken,
      tokenType: 'Bearer',
      expiresIn: getExpiresIn(),
      refreshToken: newRaw,
      refreshExpiresIn: getRefreshExpiresIn(),
    });
  } catch (error) {
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const { refreshToken: rawToken } = req.body;
    if (rawToken) {
      const hash = RefreshToken.hashToken(rawToken);
      await RefreshToken.findOneAndUpdate(
        { tokenHash: hash, userId: req.user._id, revoked: false },
        { $set: { revoked: true } }
      );
    }
    await RevokedAccessToken.updateOne(
      { jti: req.authToken.jti },
      { $setOnInsert: { jti: req.authToken.jti, expiresAt: req.authToken.expiresAt } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (error) {
    next(error);
  }
};

const logoutAll = async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $inc: { tokenVersion: 1 } },
      { new: true }
    );
    const result = await RefreshToken.updateMany(
      { userId: req.user._id, revoked: false },
      { $set: { revoked: true } }
    );
    res.json({
      success: true,
      message: `Logged out from all devices. ${result.modifiedCount} session(s) revoked.`,
      tokenVersion: user.tokenVersion,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  getMe,
  updateLanguage,
  refreshAccessToken,
  logout,
  logoutAll,
};
