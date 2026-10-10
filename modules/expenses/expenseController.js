const Expense = require('./expenseModel');
const AppError = require('../../common/utils/AppError');
const { requireEnum, requirePositiveNumber, optionalString, optionalDate } = require('../../common/utils/validators');

const EXPENSE_CATEGORIES = ['rent', 'transport', 'power', 'wages', 'repairs', 'security', 'food', 'other'];

/**
 * Record an expense
 */
const recordExpense = async (req, res, next) => {
  try {
    const { category, amount, note, date } = req.body;

    requireEnum(category, 'Category', EXPENSE_CATEGORIES);
    const parsedAmount = requirePositiveNumber(amount, 'Amount');
    const validNote = optionalString(note, 'Note');
    const parsedDate = optionalDate(date, 'Date');

    const expense = await Expense.create({
      businessId: req.businessId,
      category,
      amount: parsedAmount,
      note: validNote,
      date: parsedDate || new Date(),
      source: 'manual',
    });

    res.status(201).json({
      success: true,
      message: 'Expense recorded successfully',
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get expenses
 */
const getExpenses = async (req, res, next) => {
  try {
    const { category, startDate, endDate } = req.query;
    const filter = { businessId: req.businessId };

    if (category) filter.category = category;
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    const expenses = await Expense.find(filter).sort({ date: -1 }).limit(100);

    const totalAmount = expenses.reduce((acc, e) => acc + e.amount, 0);

    res.json({
      success: true,
      count: expenses.length,
      totalAmount,
      data: expenses,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  recordExpense,
  getExpenses,
};

