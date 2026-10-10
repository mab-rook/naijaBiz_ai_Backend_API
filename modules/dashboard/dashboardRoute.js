const express = require('express');
const router = express.Router();
const { getDashboard } = require('./dashboardController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.get('/', validateRequest({ query: schemas.dashboardQuery }), getDashboard);

module.exports = router;
