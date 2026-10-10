const express = require('express');
const router = express.Router();
const { getAlerts, markAlertAsRead, triggerAlertScan } = require('./alertController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.get('/', validateRequest({ query: schemas.alertListQuery }), getAlerts);
router.patch('/:id/read', validateRequest({ params: schemas.alertId }), markAlertAsRead);
router.post('/generate', validateRequest({ body: schemas.empty }), triggerAlertScan);

module.exports = router;
