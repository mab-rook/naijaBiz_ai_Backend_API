const { getSalesRate, getProfitAndLoss, getCashFlow, getDailySales, dayKey } = require('../reports/reportService');
const { getDebtLedger } = require('../debts/debtService');

/**
 * Builds the BusinessSnapshot the ML service expects for /ask, /insights and /forecast
 * (field names follow the ML service's API, hence snake_case).
 */

const firstOfMonth = (key) => `${key.slice(0, 8)}01`;
const previousDay = (key) => dayKey(new Date(new Date(`${key}T12:00:00+01:00`).getTime() - 24 * 60 * 60 * 1000));

// The three months before the current one, oldest first: [{ from, to }]
const previousMonths = (todayKey, count) => {
  const months = [];
  let end = previousDay(firstOfMonth(todayKey));
  for (let i = 0; i < count; i++) {
    const from = firstOfMonth(end);
    months.unshift({ from, to: end });
    end = previousDay(from);
  }
  return months;
};

const buildMlSnapshot = async (businessId) => {
  const today = dayKey(new Date());
  const thisMonth = { from: firstOfMonth(today), to: today };
  const [lastMonth, ...earlier] = previousMonths(today, 3).reverse();

  const [salesRate, daily, thisMonthPl, lastMonthPl, debts, ...cashFlows] = await Promise.all([
    getSalesRate(businessId, {}),
    getDailySales(businessId, { days: 28 }),
    getProfitAndLoss(businessId, thisMonth),
    getProfitAndLoss(businessId, lastMonth),
    getDebtLedger(businessId),
    ...[...earlier.reverse(), lastMonth].map((range) => getCashFlow(businessId, { ...range, interval: 'week' })),
  ]);

  const last28 = daily.series.reduce((sum, d) => sum + d.revenue, 0);
  const last7 = daily.series.slice(-7).reduce((sum, d) => sum + d.revenue, 0);

  return {
    business_id: String(businessId),
    products: salesRate.products.map((p) => ({
      id: String(p.productId),
      name: p.name,
      unit: p.unit || 'unit',
      stock: p.currentStock,
      min_stock: p.minimumStock || 0,
      avg_daily_sales: p.avgDailyUnits || 0,
      selling_price: p.sellingPrice ?? null,
      cost_price: p.costPrice ?? null,
    })),
    sales_this_week: last7,
    avg_weekly_sales: Math.round(last28 / 4),
    revenue_this_month: thisMonthPl.revenue,
    revenue_last_month: lastMonthPl.revenue,
    expenses_this_month: thisMonthPl.expenses.total,
    expenses_last_month: lastMonthPl.expenses.total,
    monthly_net_cashflow: cashFlows.map((cf) => cf.totals.net), // last three full months, oldest first
    debts: debts.debts
      .filter((d) => d.balanceRemaining > 0)
      .map((d) => ({ customer: d.customer.name, amount: d.balanceRemaining, days_outstanding: d.daysOutstanding })),
  };
};

module.exports = { buildMlSnapshot };
