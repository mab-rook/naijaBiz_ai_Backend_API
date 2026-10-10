const Sale = require('../sales/saleModel');
const Expense = require('../expenses/expenseModel');
const Purchase = require('../purchases/purchaseModel');
const Product = require('../products/productModel');
const Debt = require('../debts/debtModel');

/**
 * Get comprehensive business dashboard metrics
 */
const getDashboardMetrics = async (businessId, timeRange = '30d') => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let startDate;
  if (timeRange === 'today') {
    startDate = startOfDay;
  } else if (timeRange === '7d') {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (timeRange === '90d') {
    startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else {
    // default 30d
    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  // 1. Sales & Revenue
  const sales = await Sale.find({
    businessId,
    date: { $gte: startDate },
  });

  const todaySales = await Sale.find({
    businessId,
    date: { $gte: startOfDay },
  });

  const totalRevenue = sales.reduce((acc, s) => acc + s.total, 0);
  const totalCashCollected = sales.reduce((acc, s) => acc + (s.amountPaid || 0), 0);
  const todayRevenue = todaySales.reduce((acc, s) => acc + s.total, 0);

  // Calculate COGS (Cost of goods sold)
  let cogs = 0;
  sales.forEach((s) => {
    s.items.forEach((item) => {
      cogs += (item.costPrice || 0) * item.quantity;
    });
  });

  // 2. Expenses
  const expenses = await Expense.find({
    businessId,
    date: { $gte: startDate },
  });

  const todayExpenses = await Expense.find({
    businessId,
    date: { $gte: startOfDay },
  });

  const totalExpenses = expenses.reduce((acc, e) => acc + e.amount, 0);
  const todayExpensesTotal = todayExpenses.reduce((acc, e) => acc + e.amount, 0);

  // Group expenses by category
  const expensesByCategory = expenses.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});

  // 3. Profitability
  const grossProfit = totalRevenue - cogs;
  const netProfit = grossProfit - totalExpenses;
  const profitMarginPercent = totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 100) : 0;

  // 4. Inventory Valuation
  const products = await Product.find({ businessId });
  let totalStockCostValue = 0;
  let totalStockRetailValue = 0;
  let lowStockCount = 0;

  products.forEach((p) => {
    totalStockCostValue += (p.currentStock || 0) * (p.costPrice || 0);
    totalStockRetailValue += (p.currentStock || 0) * (p.sellingPrice || 0);
    if (p.currentStock <= p.minimumStock) {
      lowStockCount++;
    }
  });

  // 5. Customer Debts
  const debts = await Debt.find({ businessId, status: { $ne: 'paid' } });
  const totalOutstandingDebt = debts.reduce(
    (acc, d) => acc + Math.max(0, d.amount - d.amountPaid),
    0
  );

  // 6. Net cash flow for the period: money in (sales receipts + debt repayments)
  //    minus money out (expenses + stock purchases). Matches GET /api/reports/cash-flow totals.
  const purchases = await Purchase.find({ businessId, date: { $gte: startDate } }).select('total');
  const totalPurchases = purchases.reduce((acc, p) => acc + p.total, 0);
  const repaidDebts = await Debt.find({ businessId, 'payments.date': { $gte: startDate } }).select('payments');
  const debtRepayments = repaidDebts.reduce(
    (acc, d) => acc + d.payments.filter((p) => p.date >= startDate).reduce((sum, p) => sum + p.amount, 0),
    0
  );
  const cashIn = totalCashCollected + debtRepayments;
  const cashOut = totalExpenses + totalPurchases;
  const estimatedCashPosition = cashIn - cashOut;

  return {
    timeRange,
    revenue: {
      total: totalRevenue,
      today: todayRevenue,
      cashCollected: totalCashCollected,
    },
    expenses: {
      total: totalExpenses,
      today: todayExpensesTotal,
      byCategory: expensesByCategory,
    },
    profit: {
      grossProfit,
      cogs,
      netProfit,
      profitMarginPercent,
    },
    inventory: {
      totalProducts: products.length,
      stockCostValue: totalStockCostValue,
      stockRetailValue: totalStockRetailValue,
      lowStockCount,
    },
    debts: {
      totalOutstanding: totalOutstandingDebt,
      activeDebtorsCount: debts.length,
    },
    cashPosition: estimatedCashPosition,
    cashFlow: {
      cashIn,
      cashOut,
      salesReceipts: totalCashCollected,
      debtRepayments,
      expenses: totalExpenses,
      purchases: totalPurchases,
    },
  };
};

/**
 * Affordability evaluation ("Can I afford a freezer for ₦250,000?")
 */
const checkAffordability = async (businessId, itemPrice, itemName = 'Capital asset') => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const sales = await Sale.find({ businessId, date: { $gte: thirtyDaysAgo } });
  const expenses = await Expense.find({ businessId, date: { $gte: thirtyDaysAgo } });

  const monthlyCashIn = sales.reduce((acc, s) => acc + (s.amountPaid || 0), 0);
  const monthlyExpenses = expenses.reduce((acc, e) => acc + e.amount, 0);
  const monthlyNetCashFlow = monthlyCashIn - monthlyExpenses;

  // Safe spending buffer: recommend not spending more than 40% of 30-day net cash flow in one go
  const safeReserveRate = 0.4;
  const safeSpendingLimit = Math.max(0, Math.round(monthlyNetCashFlow * safeReserveRate));

  const canAfford = itemPrice <= safeSpendingLimit;
  const tightAfford = !canAfford && itemPrice <= monthlyNetCashFlow;

  let adviceEn = '';
  let adviceYo = '';
  let adviceHa = '';
  let adviceIg = '';

  if (canAfford) {
    adviceEn = `Yes, you can comfortably afford ${itemName} (₦${itemPrice.toLocaleString()}). Your 30-day net profit is ₦${monthlyNetCashFlow.toLocaleString()} and your safe spending limit is ₦${safeSpendingLimit.toLocaleString()}.`;
    adviceYo = `Bẹẹni, o le ra ${itemName} (₦${itemPrice.toLocaleString()}) laisi iṣoro. Ere rẹ fun osu yii to ₦${monthlyNetCashFlow.toLocaleString()}.`;
    adviceHa = `Ee, zaka iya siyan ${itemName} (₦${itemPrice.toLocaleString()}) cikin sauki. Ribar da ka samu a watan nan ita ce ₦${monthlyNetCashFlow.toLocaleString()}.`;
    adviceIg = `Ee, ị nwere ike ịzụta ${itemName} (₦${itemPrice.toLocaleString()}) n'enweghị nsogbu. Uru ị nwetara n'ọnwa a bụ ₦${monthlyNetCashFlow.toLocaleString()}.`;
  } else if (tightAfford) {
    adviceEn = `You have enough cash (₦${monthlyNetCashFlow.toLocaleString()}), but spending ₦${itemPrice.toLocaleString()} on ${itemName} will leave your working capital tight for restocking. Consider waiting or installment.`;
    adviceYo = `Owo wa, ṣugbọn rira ${itemName} le fa iṣoro fun rira ọja miiran. O dara ki o duro diẹ tabi ki o san diẹ-diẹ.`;
    adviceHa = `Kana da kudin, amma siyan ${itemName} zai iya rage kudin jarin siyan kaya. Zai fi kyau ka dakata kadan ko ka biya a hankali.`;
    adviceIg = `Ị nwere ego, mana ịzụta ${itemName} ga-eme ka ego maka ngwongwo ọhụrụ dị ntakịrị. Ọ ga-akara gị mma ichere ntakịrị ma ọ bụ kwụọ ya nwayọọ nwayọọ.`;
  } else {
    adviceEn = `Not recommended right now. ${itemName} costs ₦${itemPrice.toLocaleString()}, but your monthly net cash flow is ₦${monthlyNetCashFlow.toLocaleString()}. Your safe spending range is up to ₦${safeSpendingLimit.toLocaleString()}.`;
    adviceYo = `Ko ni imọran lati ra bayii. ${itemName} jẹ ₦${itemPrice.toLocaleString()}, ṣugbọn ere rẹ jẹ ₦${monthlyNetCashFlow.toLocaleString()}. O pọ ju fun akoko yii.`;
    adviceHa = `Ba a ba da shawarar siya ba a yanzu. Farashin ${itemName} ya kai ₦${itemPrice.toLocaleString()}, amma ribarka ₦${monthlyNetCashFlow.toLocaleString()} ce.`;
    adviceIg = `Akwadoghị ịzụta ya ugbu a. ${itemName} dị ₦${itemPrice.toLocaleString()}, mana uru ọnwa gị bụ ₦${monthlyNetCashFlow.toLocaleString()}.`;
  }

  return {
    itemPrice,
    itemName,
    monthlyNetCashFlow,
    safeSpendingLimit,
    verdict: canAfford ? 'SAFE_TO_BUY' : tightAfford ? 'PROCEED_WITH_CAUTION' : 'NOT_RECOMMENDED',
    advice: {
      en: adviceEn,
      yo: adviceYo,
      ha: adviceHa,
      ig: adviceIg,
    },
  };
};

module.exports = {
  getDashboardMetrics,
  checkAffordability,
};

