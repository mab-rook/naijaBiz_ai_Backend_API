const express = require('express');
const router = express.Router();
const { recordPurchase, getPurchases } = require('./purchaseController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.route('/')
  .post(validateRequest({ body: schemas.purchaseCreate }), recordPurchase)
  .get(getPurchases);

module.exports = router;
