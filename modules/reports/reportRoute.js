const express = require('express');
const router = express.Router();
const {
  getProfitAndLoss,
  getCashFlow,
  getTopProducts,
  getSalesRate,
  getDailySales,
} = require('./reportController');
const { protectUserOrService } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

// Read-only: callable by the merchant app (JWT) or the ML service (X-API-Key + X-Business-Id)
router.use(protectUserOrService);

router.get('/profit-loss', validateRequest({ query: schemas.reportRange }), getProfitAndLoss);
router.get('/cash-flow', validateRequest({ query: schemas.cashFlowQuery }), getCashFlow);
router.get('/top-products', validateRequest({ query: schemas.topProductsQuery }), getTopProducts);
router.get('/sales-rate', validateRequest({ query: schemas.salesRateQuery }), getSalesRate);
router.get('/daily-sales', validateRequest({ query: schemas.dailySalesQuery }), getDailySales);

module.exports = router;
