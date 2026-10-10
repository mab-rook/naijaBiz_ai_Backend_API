const Sale = require('../sales/saleModel');
const Purchase = require('../purchases/purchaseModel');
const Expense = require('../expenses/expenseModel');
const Debt = require('../debts/debtModel');
const Product = require('../products/productModel');
const StockMovement = require('../inventory/stockMovementModel');
const AppError = require('../../common/utils/AppError');

/**
 * Financial reports and the data feeds the ML service uses for forecasts / Ask My Business.
 * All dates are bucketed in Nigerian time (WAT, UTC+1, no daylight saving).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WAT_OFFSET_MS = 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Lagos calendar date (YYYY-MM-DD) of an instant
const dayKey = (date) => new Date(date.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
// Lagos calendar day -> the instant it starts
const startOfDay = (key) => new Date(`${key}T00:00:00+01:00`);
const addDays = (key, n) => dayKey(new Date(startOfDay(key).getTime() + n * DAY_MS + WAT_OFFSET_MS));
const dayOfWeek = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
// Monday of the week containing this day
const weekKey = (date) => {
  const key = dayKey(date);
  return addDays(key, -((dayOfWeek(key) + 6) % 7));
};

const isDateKey = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(startOfDay(v).getTime()) &&
  dayKey(startOfDay(v)) === v;

/**
 * from/to are inclusive Lagos calendar days (YYYY-MM-DD). Defaults to the last `defaultDays` days.
 * Returns { from, to, start, end } where end is exclusive.
 */
const parseRange = ({ from, to } = {}, defaultDays = 30) => {
  if (from !== undefined && !isDateKey(from)) throw new AppError(400, '"from" must be a date like 2026-10-01', 'INVALID_DATE');
  if (to !== undefined && !isDateKey(to)) throw new AppError(400, '"to" must be a date like 2026-10-31', 'INVALID_DATE');
  const toKey = to || dayKey(new Date());
  const fromKey = from || addDays(toKey, -(defaultDays - 1));
  const start = startOfDay(fromKey);
  const end = startOfDay(addDays(toKey, 1));
  const days = Math.round((end - start) / DAY_MS);
  if (days <= 0) throw new AppError(400, '"from" must be on or before "to"', 'INVALID_DATE');
  if (days > MAX_RANGE_DAYS) throw new AppError(400, `Date range cannot exceed ${MAX_RANGE_DAYS} days`, 'INVALID_DATE');
  return { from: fromKey, to: toKey, start, end, days };
};

const round2 = (n) => Math.round(n * 100) / 100;
const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Revenue, units, cost and profit per product from sale lines */
const aggregateSaleLines = (sales) => {
  const byProduct = new Map();
  for (const sale of sales) {
    for (const item of sale.items) {
      const key = String(item.productId);
      const row = byProduct.get(key) || {
        productId: item.productId,
        name: item.productName,
        unit: item.unit,
        quantity: 0,
        revenue: 0,
        cogs: 0,
      };
      row.quantity += item.quantity;
      row.revenue += item.subtotal;
      row.cogs += (item.costPrice || 0) * item.quantity;
      byProduct.set(key, row);
    }
  }
  return [...byProduct.values()].map((r) => ({ ...r, grossProfit: r.revenue - r.cogs }));
};

/** Profit & loss for a period */
const getProfitAndLoss = async (businessId, query) => {
  const range = parseRange(query);
  const dateFilter = { $gte: range.start, $lt: range.end };
  const [sales, expenses] = await Promise.all([
    Sale.find({ businessId, date: dateFilter }).lean(),
    Expense.find({ businessId, date: dateFilter }).lean(),
  ]);

  const revenue = sales.reduce((sum, s) => sum + s.total, 0);
  const lines = aggregateSaleLines(sales);
  const cogs = lines.reduce((sum, r) => sum + r.cogs, 0);
  const grossProfit = revenue - cogs;
  const expensesByCategory = {};
  for (const e of expenses) expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount;
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const netProfit = grossProfit - totalExpenses;

  return {
    period: { from: range.from, to: range.to, days: range.days },
    currency: 'NGN',
    salesCount: sales.length,
    revenue,
    cogs,
    grossProfit,
    grossMarginPercent: percent(grossProfit, revenue),
    expenses: { total: totalExpenses, byCategory: expensesByCategory },
    netProfit,
    netMarginPercent: percent(netProfit, revenue),
    byProduct: lines.sort((a, b) => b.revenue - a.revenue),
  };
};

/**
 * Cash flow per day or week.
 * Cash in  = money received on sales + debt repayments.
 * Cash out = expenses + stock purchases (purchases are assumed paid when recorded).
 */
const getCashFlow = async (businessId, query) => {
  const interval = query.interval || 'day';
  if (!['day', 'week'].includes(interval)) throw new AppError(400, '"interval" must be "day" or "week"', 'INVALID_INTERVAL');
  const range = parseRange(query);
  const dateFilter = { $gte: range.start, $lt: range.end };
  const bucketOf = interval === 'day' ? dayKey : weekKey;

  const [sales, expenses, purchases, debts] = await Promise.all([
    Sale.find({ businessId, date: dateFilter }).select('date amountPaid').lean(),
    Expense.find({ businessId, date: dateFilter }).select('date amount').lean(),
    Purchase.find({ businessId, date: dateFilter }).select('date total').lean(),
    Debt.find({ businessId, 'payments.date': dateFilter }).select('payments').lean(),
  ]);

  // Pre-fill every bucket so charts get a continuous series
  const buckets = new Map();
  for (let key = range.from; key <= range.to; key = addDays(key, 1)) {
    const b = bucketOf(startOfDay(key));
    if (!buckets.has(b)) buckets.set(b, { period: b, salesReceipts: 0, debtRepayments: 0, expenses: 0, purchases: 0 });
  }
  const add = (date, field, amount) => {
    const row = buckets.get(bucketOf(date));
    if (row) row[field] += amount || 0;
  };

  sales.forEach((s) => add(s.date, 'salesReceipts', s.amountPaid));
  expenses.forEach((e) => add(e.date, 'expenses', e.amount));
  purchases.forEach((p) => add(p.date, 'purchases', p.total));
  debts.forEach((d) =>
    d.payments.forEach((p) => {
      if (p.date >= range.start && p.date < range.end) add(p.date, 'debtRepayments', p.amount);
    })
  );

  let cumulative = 0;
  const series = [...buckets.values()].map((row) => {
    const cashIn = row.salesReceipts + row.debtRepayments;
    const cashOut = row.expenses + row.purchases;
    cumulative += cashIn - cashOut;
    return { ...row, cashIn, cashOut, net: cashIn - cashOut, cumulativeNet: cumulative };
  });

  const totals = series.reduce(
    (acc, r) => {
      for (const k of ['salesReceipts', 'debtRepayments', 'expenses', 'purchases', 'cashIn', 'cashOut', 'net']) acc[k] += r[k];
      return acc;
    },
    { salesReceipts: 0, debtRepayments: 0, expenses: 0, purchases: 0, cashIn: 0, cashOut: 0, net: 0 }
  );

  return { period: { from: range.from, to: range.to, days: range.days }, currency: 'NGN', interval, totals, series };
};

/** Best sellers for a period, by revenue, quantity or gross profit */
const getTopProducts = async (businessId, query) => {
  const by = query.by || 'revenue';
  const sortField = { revenue: 'revenue', quantity: 'quantity', profit: 'grossProfit' }[by];
  if (!sortField) throw new AppError(400, '"by" must be revenue, quantity or profit', 'INVALID_SORT');
  const limit = query.limit === undefined ? 5 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, '"limit" must be 1-50', 'INVALID_LIMIT');

  const range = parseRange(query);
  const sales = await Sale.find({ businessId, date: { $gte: range.start, $lt: range.end } }).lean();
  const products = aggregateSaleLines(sales)
    .sort((a, b) => b[sortField] - a[sortField])
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, ...p }));

  return { period: { from: range.from, to: range.to, days: range.days }, by, products };
};

const parseDays = (value, fallback, max = 180) => {
  const days = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > max) throw new AppError(400, `"days" must be 1-${max}`, 'INVALID_DAYS');
  return days;
};

/**
 * Per-product sales rate over the last N days (default 14): the input for stock-out forecasts.
 * daysOfStockLeft = currentStock / average daily units sold (null when nothing sold).
 */
const getSalesRate = async (businessId, query) => {
  const days = parseDays(query.days, 14);
  const since = new Date(Date.now() - days * DAY_MS);
  const [products, movements] = await Promise.all([
    Product.find({ businessId }).sort({ name: 1 }).lean(),
    StockMovement.find({ businessId, type: 'sale', date: { $gte: since } }).select('productId quantity').lean(),
  ]);

  const sold = new Map();
  movements.forEach((m) => sold.set(String(m.productId), (sold.get(String(m.productId)) || 0) + Math.abs(m.quantity)));

  return {
    windowDays: days,
    products: products.map((p) => {
      const unitsSold = sold.get(String(p._id)) || 0;
      const avgDailyUnits = round2(unitsSold / days);
      return {
        productId: p._id,
        name: p.name,
        unit: p.unit,
        currentStock: p.currentStock,
        minimumStock: p.minimumStock,
        sellingPrice: p.sellingPrice,
        costPrice: p.costPrice,
        unitsSold,
        avgDailyUnits,
        daysOfStockLeft: avgDailyUnits > 0 ? round2(p.currentStock / avgDailyUnits) : null,
      };
    }),
  };
};

/** Daily sales series for the last N days (default 30), optionally for one product: forecasting / weekend patterns */
const getDailySales = async (businessId, query) => {
  const days = parseDays(query.days, 30, 366);
  const range = parseRange({}, days);
  const productId = query.productId;

  const sales = await Sale.find({ businessId, date: { $gte: range.start, $lt: range.end } }).lean();
  const rows = new Map();
  for (let key = range.from; key <= range.to; key = addDays(key, 1)) {
    rows.set(key, { date: key, dayOfWeek: DAY_NAMES[dayOfWeek(key)], salesCount: 0, units: 0, revenue: 0 });
  }

  for (const sale of sales) {
    const row = rows.get(dayKey(sale.date));
    if (!row) continue;
    const lines = productId ? sale.items.filter((it) => String(it.productId) === String(productId)) : sale.items;
    if (!lines.length) continue;
    row.salesCount += 1;
    row.units += lines.reduce((sum, it) => sum + it.quantity, 0);
    row.revenue += productId ? lines.reduce((sum, it) => sum + it.subtotal, 0) : sale.total;
  }

  const series = [...rows.values()];
  // Average revenue per weekday: lets the ML side (or the app) spot weekend demand
  const byWeekday = DAY_NAMES.map((name) => {
    const daysOfType = series.filter((r) => r.dayOfWeek === name);
    const revenue = daysOfType.reduce((sum, r) => sum + r.revenue, 0);
    return { dayOfWeek: name, days: daysOfType.length, avgRevenue: daysOfType.length ? Math.round(revenue / daysOfType.length) : 0 };
  });

  return { period: { from: range.from, to: range.to, days: range.days }, productId: productId || null, series, byWeekday };
};

module.exports = {
  getProfitAndLoss,
  getCashFlow,
  getTopProducts,
  getSalesRate,
  getDailySales,
  // exported for reuse/tests
  parseRange,
  dayKey,
};
