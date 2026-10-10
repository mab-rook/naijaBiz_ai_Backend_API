const express = require('express');
const router = express.Router();
const { register, login, getMe, updateLanguage, refreshAccessToken, logout, logoutAll } = require('./authController');
const { protect } = require('./authMiddleware');
const { loginLimiterByIp, loginLimiterByPhone, registerLimiter } = require('../../common/middleware/rateLimiter');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.post('/register', validateRequest({ body: schemas.authRegister }), registerLimiter, register);
router.post('/login', validateRequest({ body: schemas.authLogin }), loginLimiterByIp, loginLimiterByPhone, login);
router.post('/refresh', validateRequest({ body: schemas.refresh }), refreshAccessToken);
router.post('/logout', protect, validateRequest({ body: schemas.logout }), logout);
router.post('/logout-all', protect, validateRequest({ body: schemas.empty }), logoutAll);
router.get('/me', protect, getMe);
router.put('/language', protect, validateRequest({ body: schemas.language }), updateLanguage);

module.exports = router;
