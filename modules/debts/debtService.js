const Debt = require('./debtModel');
const Customer = require('./customerModel');
const AppError = require('../../common/utils/AppError');
const withTransaction = require('../../common/utils/withTransaction');

const getAgeingBucket = (days) => {
  if (days <= 7) return 'under7Days';
  if (days <= 14) return 'between8And14Days';
  if (days <= 30) return 'between15And30Days';
  return 'over30Days';
};

/**
 * Get customer debts breakdown with ageing
 */
const getDebtLedger = async (businessId) => {
  const debts = await Debt.find({ businessId })
    .populate('customerId', 'name phone')
    .sort({ createdDate: -1 });

  let totalOutstanding = 0;
  let totalRecovered = 0;
  const ageing = {
    under7Days: { count: 0, amount: 0 },
    between8And14Days: { count: 0, amount: 0 },
    between15And30Days: { count: 0, amount: 0 },
    over30Days: { count: 0, amount: 0 },
  };

  const formattedDebts = debts.map((debt) => {
    const remaining = Math.max(0, debt.amount - debt.amountPaid);
    totalOutstanding += remaining;
    totalRecovered += debt.amountPaid;

    const days = debt.daysOutstanding;

    if (remaining > 0) {
      const bucket = ageing[getAgeingBucket(days)];
      bucket.count++;
      bucket.amount += remaining;
    }

    return {
      _id: debt._id,
      customer: debt.customerId ? { id: debt.customerId._id, name: debt.customerId.name, phone: debt.customerId.phone } : { name: 'Unknown Customer' },
      originalAmount: debt.amount,
      amountPaid: debt.amountPaid,
      balanceRemaining: remaining,
      status: remaining === 0 ? 'cleared' : debt.amountPaid > 0 ? 'partial' : 'unpaid',
      createdDate: debt.createdDate,
      dueDate: debt.dueDate,
      daysOutstanding: days,
      payments: debt.payments,
      notes: debt.notes,
    };
  });

  return {
    totalDebtsCount: debts.length,
    activeDebtorsCount: formattedDebts.filter((d) => d.balanceRemaining > 0).length,
    totalOutstandingAmount: totalOutstanding,
    totalRecoveredAmount: totalRecovered,
    ageingSummary: ageing,
    debts: formattedDebts,
  };
};

/**
 * Record a debt repayment
 */
const recordDebtPayment = async (businessId, debtId, amount, note = '', session) => {
  if (!session) {
    return withTransaction((transactionSession) =>
      recordDebtPayment(businessId, debtId, amount, note, transactionSession)
    );
  }
  const debt = await Debt.findOne({ _id: debtId, businessId }).populate('customerId').session(session);
  if (!debt) {
    throw new AppError(404, 'Debt record not found', 'DEBT_NOT_FOUND');
  }

  const remaining = Math.max(0, debt.amount - debt.amountPaid);
  if (amount > remaining) {
    throw new AppError(400, `Payment amount (₦${amount.toLocaleString()}) exceeds outstanding balance (₦${remaining.toLocaleString()})`, 'PAYMENT_EXCEEDS_BALANCE');
  }

  debt.amountPaid += amount;
  debt.payments.push({
    date: new Date(),
    amount,
    note: note || 'Cash repayment',
  });

  if (debt.amountPaid >= debt.amount) {
    debt.status = 'paid';
  } else {
    debt.status = 'partial';
  }

  await debt.save({ session });
  return debt;
};

/**
 * Generate localized reminder messages
 */
const generateReminderDraft = (customerName, amount, businessName = 'Our Store', language = 'en') => {
  const formattedAmount = `₦${Number(amount).toLocaleString()}`;

  const templates = {
    en: `Hello ${customerName}, this is a gentle reminder from ${businessName} regarding your outstanding balance of ${formattedAmount}. Please make payment at your earliest convenience. Thank you for your patronage!`,
    yo: `E ku osan ${customerName}, e jowo e ranti owo ${formattedAmount} to ku lati san fun ${businessName}. E se pupo fun ifowosowopo yin!`,
    ha: `Barka da yini ${customerName}, muna tunatar da kai game da kudin da ya rage ${formattedAmount} a shagon ${businessName}. Da fatan za a biya nan ba da jimawa ba. Mungode!`,
    ig: `Nnọọ ${customerName}, nke a bụ ncheta sitere na ${businessName} gbasara ego ${formattedAmount} ị ji anyị. Biko kwụọ ya n'oge na-adịghị anya. Daalụ nke ukwuu!`,
  };

  return {
    language,
    customerName,
    amount: formattedAmount,
    message: templates[language] || templates.en,
    allLanguages: templates,
  };
};

module.exports = {
  getDebtLedger,
  recordDebtPayment,
  generateReminderDraft,
  getAgeingBucket,
};
