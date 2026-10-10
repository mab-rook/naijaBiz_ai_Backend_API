const Alert = require('./alertModel');
const Product = require('../products/productModel');
const Sale = require('../sales/saleModel');
const Expense = require('../expenses/expenseModel');
const Debt = require('../debts/debtModel');
const { calculateDaysRemaining } = require('../inventory/stockService');
const { generateInsights } = require('./insightService');

/**
 * Scan business data and generate proactive alerts
 */
const generateProactiveAlerts = async (businessId) => {
  const generatedAlerts = [];
  const now = new Date();

  // 1. Check Low Stock & Stock-Outs
  const products = await Product.find({ businessId });
  for (const prod of products) {
    if (prod.currentStock <= prod.minimumStock) {
      // Avoid duplicate alert if unread alert already exists for this product
      const existingAlert = await Alert.findOne({
        businessId,
        type: 'low_stock',
        'metadata.productId': prod._id,
        read: false,
      });

      if (!existingAlert) {
        const isCritical = prod.currentStock === 0;
        const alert = await Alert.create({
          businessId,
          type: 'low_stock',
          title: isCritical ? `Out of Stock: ${prod.name}` : `Low Stock Alert: ${prod.name}`,
          message: isCritical
            ? `You have completely run out of ${prod.name}! Restock immediately to prevent lost sales.`
            : `Stock of ${prod.name} is down to ${prod.currentStock} ${prod.unit}(s) (minimum threshold is ${prod.minimumStock}).`,
          messageLocalized: {
            yo: `Ọja ${prod.name} ti lọ silẹ si ${prod.currentStock} ${prod.unit}. O yẹ ki o ra si!`,
            ha: `Kayan ${prod.name} ya kusa karewa, saura ${prod.currentStock} ${prod.unit}. Yakamata a siyo sabo!`,
            ig: `Ngwongwo ${prod.name} fọdụrụ naanị ${prod.currentStock} ${prod.unit}. Oge eruola iji zụtakwuo!`,
          },
          severity: isCritical ? 'critical' : 'warning',
          metadata: {
            productId: prod._id,
            productName: prod.name,
            currentStock: prod.currentStock,
            minimumStock: prod.minimumStock,
          },
        });
        generatedAlerts.push(alert);
      }
    }

    // Check restock suggestion based on days remaining (< 3 days left)
    const daysLeft = await calculateDaysRemaining(businessId, prod._id, prod.currentStock);
    if (daysLeft < 3 && prod.currentStock > 0) {
      const existingRestockAlert = await Alert.findOne({
        businessId,
        type: 'restock_suggestion',
        'metadata.productId': prod._id,
        read: false,
      });

      if (!existingRestockAlert) {
        const alert = await Alert.create({
          businessId,
          type: 'restock_suggestion',
          title: `Fast Selling: Restock ${prod.name}`,
          message: `At your current sales rate, your stock of ${prod.name} will run out in about ${daysLeft} days. We recommend ordering more today.`,
          messageLocalized: {
            yo: `Ni iwọn ti o n ta a, ${prod.name} rẹ yoo tan ni bi ọjọ ${daysLeft}. Ra si loni!`,
            ha: `Dangane da yadda kake sayarwa, ${prod.name} zai kare nan da kwanaki ${daysLeft}. Yi odar sabo yau!`,
            ig: `Dịka ị na-ere ya, ${prod.name} gị ga-agwụ n'ihe dịka ụbọchị ${daysLeft}. Zụtakwuo taa!`,
          },
          severity: 'info',
          metadata: {
            productId: prod._id,
            productName: prod.name,
            daysLeft,
          },
        });
        generatedAlerts.push(alert);
      }
    }
  }

  // 2. Check Overdue Debts (> 14 days)
  const debts = await Debt.find({
    businessId,
    status: { $ne: 'paid' },
  }).populate('customerId');

  for (const debt of debts) {
    const days = debt.daysOutstanding;
    if (days >= 14) {
      const existingDebtAlert = await Alert.findOne({
        businessId,
        type: 'overdue_debt',
        'metadata.debtId': debt._id,
        read: false,
      });

      if (!existingDebtAlert) {
        const remaining = debt.amount - debt.amountPaid;
        const customerName = debt.customerId ? debt.customerId.name : 'Customer';
        const alert = await Alert.create({
          businessId,
          type: 'overdue_debt',
          title: `Overdue Customer Debt: ${customerName}`,
          message: `${customerName} owes ₦${remaining.toLocaleString()} which is now ${days} days old. Send a payment reminder today.`,
          messageLocalized: {
            yo: `${customerName} jẹ ₦${remaining.toLocaleString()} fun ọjọ ${days} bayi. Fi iranti ranṣẹ si wọn!`,
            ha: `${customerName} yana bin bashi ₦${remaining.toLocaleString()} tsawon kwanaki ${days}. Tura masa da sakon tunatarwa yau!`,
            ig: `${customerName} ji ₦${remaining.toLocaleString()} kemgbe ụbọchị ${days}. Ziga ya ozi ncheta taa!`,
          },
          severity: days > 30 ? 'critical' : 'warning',
          metadata: {
            debtId: debt._id,
            customerId: debt.customerId ? debt.customerId._id : null,
            customerName,
            amountOwed: remaining,
            daysOutstanding: days,
          },
        });
        generatedAlerts.push(alert);
      }
    }
  }

  // 3. Sales Drop & Rising Expenses Check
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [thisWeekSales, prevWeekSales] = await Promise.all([
    Sale.find({ businessId, date: { $gte: sevenDaysAgo } }),
    Sale.find({ businessId, date: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo } }),
  ]);

  const thisWeekTotal = thisWeekSales.reduce((a, b) => a + b.total, 0);
  const prevWeekTotal = prevWeekSales.reduce((a, b) => a + b.total, 0);

  if (prevWeekTotal > 0 && thisWeekTotal < prevWeekTotal * 0.75) {
    const dropPercent = Math.round(((prevWeekTotal - thisWeekTotal) / prevWeekTotal) * 100);
    const existingSalesAlert = await Alert.findOne({
      businessId,
      type: 'sales_drop',
      createdAt: { $gte: sevenDaysAgo },
    });

    if (!existingSalesAlert) {
      const alert = await Alert.create({
        businessId,
        type: 'sales_drop',
        title: `Sales Drop Detected (-${dropPercent}%)`,
        message: `Sales this week (₦${thisWeekTotal.toLocaleString()}) dropped ${dropPercent}% compared to last week (₦${prevWeekTotal.toLocaleString()}). Check your bestsellers and foot traffic.`,
        messageLocalized: {
          yo: `Iye ọja ti o ta ni ọsẹ yii dinku nipasẹ ${dropPercent}%. Ṣayẹwo awọn ọja rẹ to n ta julọ!`,
          ha: `Cinikin makon nan ya ragu da kashi ${dropPercent}%. Bincika kayan da suka fi tafiya!`,
          ig: `Ahịa izu a dara site na ${dropPercent}%. Lelee ngwongwo kachasị ere!`,
        },
        severity: 'warning',
        metadata: { thisWeekTotal, prevWeekTotal, dropPercent },
      });
      generatedAlerts.push(alert);
    }
  }

  // 4. Rising Expenses: this week vs last week, flagged above ALERT_EXPENSE_RISE_PERCENT (default 25%)
  const risePercentThreshold = Number(process.env.ALERT_EXPENSE_RISE_PERCENT) || 25;
  const [thisWeekExpenses, prevWeekExpenses] = await Promise.all([
    Expense.find({ businessId, date: { $gte: sevenDaysAgo } }),
    Expense.find({ businessId, date: { $gte: fourteenDaysAgo, $lt: sevenDaysAgo } }),
  ]);
  const sumByCategory = (list) =>
    list.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + e.amount;
      return acc;
    }, {});
  const thisWeekExpenseTotal = thisWeekExpenses.reduce((a, e) => a + e.amount, 0);
  const prevWeekExpenseTotal = prevWeekExpenses.reduce((a, e) => a + e.amount, 0);

  if (prevWeekExpenseTotal > 0 && thisWeekExpenseTotal > prevWeekExpenseTotal * (1 + risePercentThreshold / 100)) {
    const risePercent = Math.round(((thisWeekExpenseTotal - prevWeekExpenseTotal) / prevWeekExpenseTotal) * 100);
    const existingExpenseAlert = await Alert.findOne({
      businessId,
      type: 'rising_expenses',
      createdAt: { $gte: sevenDaysAgo },
    });

    if (!existingExpenseAlert) {
      // Name the category that grew the most, so the merchant knows where to look
      const thisWeekByCategory = sumByCategory(thisWeekExpenses);
      const prevWeekByCategory = sumByCategory(prevWeekExpenses);
      const [topCategory, topIncrease] = Object.keys(thisWeekByCategory)
        .map((cat) => [cat, thisWeekByCategory[cat] - (prevWeekByCategory[cat] || 0)])
        .sort((a, b) => b[1] - a[1])[0];

      const alert = await Alert.create({
        businessId,
        type: 'rising_expenses',
        title: `Expenses Up ${risePercent}% This Week`,
        message: `You spent ₦${thisWeekExpenseTotal.toLocaleString()} this week, ${risePercent}% more than last week (₦${prevWeekExpenseTotal.toLocaleString()}). The biggest increase is ${topCategory} (+₦${topIncrease.toLocaleString()}).`,
        messageLocalized: {
          yo: `Inawo rẹ ni ọsẹ yii pọ si nipasẹ ${risePercent}% (₦${thisWeekExpenseTotal.toLocaleString()}). Eyi to pọ julọ ni ${topCategory}.`,
          ha: `Kudaden da ka kashe a makon nan sun karu da kashi ${risePercent}% (₦${thisWeekExpenseTotal.toLocaleString()}). Mafi karuwa shine ${topCategory}.`,
          ig: `Mmefu gị n'izu a rịgoro site na ${risePercent}% (₦${thisWeekExpenseTotal.toLocaleString()}). Nke kachasị rịgoo bụ ${topCategory}.`,
        },
        severity: risePercent >= 50 ? 'critical' : 'warning',
        metadata: {
          thisWeekTotal: thisWeekExpenseTotal,
          prevWeekTotal: prevWeekExpenseTotal,
          risePercent,
          topCategory,
          topCategoryIncrease: topIncrease,
        },
      });
      generatedAlerts.push(alert);
    }
  }

  // 5. Insights (ML service, or local rules such as weekend demand). A failure here must not
  //    lose the alerts above, so it is isolated.
  try {
    generatedAlerts.push(...(await generateInsights(businessId)));
  } catch (err) {
    console.error(`[insights] failed for business ${businessId}: ${err.message}`);
  }

  return generatedAlerts;
};

module.exports = {
  generateProactiveAlerts,
};

