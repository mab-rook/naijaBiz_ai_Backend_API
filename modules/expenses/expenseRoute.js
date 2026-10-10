const express = require('express');
const router = express.Router();
const { recordExpense, getExpenses } = require('./expenseController');
const { protect } = require('../auth/authMiddleware');
const { validateRequest, schemas } = require('../../common/middleware/requestValidation');

router.use(protect);

router.route('/')
  .post(validateRequest({ body: schemas.expenseCreate }), recordExpense)
  .get(validateRequest({ query: schemas.expenseQuery }), getExpenses);

module.exports = router;
