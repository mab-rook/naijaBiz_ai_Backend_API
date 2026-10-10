const express = require('express');

const authRoutes = require('./modules/auth/authRoute');
const productRoutes = require('./modules/products/productRoute');
const stockRoutes = require('./modules/inventory/stockRoute');
const saleRoutes = require('./modules/sales/saleRoute');
const purchaseRoutes = require('./modules/purchases/purchaseRoute');
const expenseRoutes = require('./modules/expenses/expenseRoute');
const debtRoutes = require('./modules/debts/debtRoute');
const dashboardRoutes = require('./modules/dashboard/dashboardRoute');
const alertRoutes = require('./modules/alerts/alertRoute');
const aiRoutes = require('./modules/ai/aiRoute');
const reportRoutes = require('./modules/reports/reportRoute');

const router = express.Router();

// Each feature module owns its routes; mounted here under /api
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/stock', stockRoutes);
router.use('/sales', saleRoutes);
router.use('/purchases', purchaseRoutes);
router.use('/expenses', expenseRoutes);
router.use('/debts', debtRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/alerts', alertRoutes);
router.use('/ai', aiRoutes);
router.use('/reports', reportRoutes);

module.exports = router;
