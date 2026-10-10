const express = require('express');
const router = express.Router();
const { recordSale, getSales } = require('./saleController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.route('/')
  .post(validateRequest({ body: schemas.saleCreate }), recordSale)
  .get(validateRequest({ query: schemas.saleQuery }), getSales);

module.exports = router;
