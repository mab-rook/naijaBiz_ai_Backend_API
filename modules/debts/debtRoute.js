const express = require('express');
const router = express.Router();
const {
  getDebts,
  payDebt,
  getReminderDraft,
  getCustomers,
  createCustomer,
} = require('./debtController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.get('/', getDebts);
router.post('/payments', validateRequest({ body: schemas.debtPayment }), payDebt);
router.get('/reminders/:debtId', validateRequest({ params: schemas.debtId, query: schemas.reminderQuery }), getReminderDraft);
router.get('/customers', getCustomers);
router.post('/customers', validateRequest({ body: schemas.customerCreate }), createCustomer);

module.exports = router;
