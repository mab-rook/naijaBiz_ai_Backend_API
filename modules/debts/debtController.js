const Customer = require('./customerModel');
const Debt = require('./debtModel');
const { getDebtLedger, recordDebtPayment, generateReminderDraft } = require('./debtService');
const AppError = require('../../common/utils/AppError');
const { requireObjectId, requirePositiveNumber, requireString, optionalString } = require('../../common/utils/validators');

/**
 * Get customer debt ledger with ageing breakdown
 */
const getDebts = async (req, res, next) => {
  try {
    const ledger = await getDebtLedger(req.businessId);
    res.json({
      success: true,
      data: ledger,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Record a debt payment
 */
const payDebt = async (req, res, next) => {
  try {
    const { debtId, amount, note } = req.body;

    requireObjectId(debtId, 'debtId');
    const parsedAmount = requirePositiveNumber(amount, 'Payment amount');
    const validNote = optionalString(note, 'Note');

    const updatedDebt = await recordDebtPayment(req.businessId, debtId, parsedAmount, validNote);

    res.json({
      success: true,
      message: `Payment of ₦${parsedAmount.toLocaleString()} recorded successfully`,
      data: updatedDebt,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Generate localized reminder draft for a specific debt
 */
const getReminderDraft = async (req, res, next) => {
  try {
    const { debtId } = req.params;
    const { language } = req.query;

    const debt = await Debt.findOne({ _id: debtId, businessId: req.businessId }).populate('customerId');
    if (!debt) {
      throw new AppError(404, 'Debt not found', 'DEBT_NOT_FOUND');
    }

    const customerName = debt.customerId ? debt.customerId.name : 'Valued Customer';
    const balance = Math.max(0, debt.amount - debt.amountPaid);

    const draft = generateReminderDraft(
      customerName,
      balance,
      req.user && req.user.business ? req.user.business.name : 'Our Store',
      language || (req.user ? req.user.preferredLanguage : 'en')
    );

    res.json({
      success: true,
      data: draft,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get customer list
 */
const getCustomers = async (req, res, next) => {
  try {
    const customers = await Customer.find({ businessId: req.businessId }).sort({ name: 1 });
    res.json({
      success: true,
      count: customers.length,
      data: customers,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Add a customer
 */
const createCustomer = async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    
    const validName = requireString(name, 'Customer name', { maxLength: 200 });
    const validPhone = optionalString(phone, 'Phone number', { maxLength: 20 });

    const customer = await Customer.create({
      businessId: req.businessId,
      name: validName,
      phone: validPhone,
    });

    res.status(201).json({ success: true, data: customer });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDebts,
  payDebt,
  getReminderDraft,
  getCustomers,
  createCustomer,
};
