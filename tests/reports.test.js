/**
 * Reports (P&L, cash flow, top products, sales rate, daily sales), ML service-key access,
 * and the stock / product / sale correctness rules. Uses a fresh business with known numbers.
 */
const http = require('http');
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';
process.env.ML_SERVICE_URL = '';
process.env.DEMO_MODE = 'false';
process.env.INTERNAL_SERVICE_API_KEY = 'test-internal-service-key-1234567890';

const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
const { dayKey } = require('../modules/reports/reportService');
const Product = require('../modules/products/productModel');
const StockMovement = require('../modules/inventory/stockMovementModel');
const Sale = require('../modules/sales/saleModel');
const Purchase = require('../modules/purchases/purchaseModel');
const Debt = require('../modules/debts/debtModel');
const Customer = require('../modules/debts/customerModel');

let server;
let baseUrl;
let token;

const call = async (method, endpoint, { json, headers } = {}) => {
  const h = { ...(headers || { Authorization: `Bearer ${token}` }) };
  if (json) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${endpoint}`, { method, headers: h, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, body: await res.json() };
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data;
};

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('Reports & stock-rules tests\n');
  try {
    await connectDB();
    await seedDatabase();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Fresh, empty business so every number below is known
    const reg = await call('POST', '/api/auth/register', {
      json: { name: 'Report Tester', phone: '08055550000', password: 'secret123', businessName: 'Report Shop' },
      headers: {},
    });
    assert.equal(reg.status, 201);
    token = reg.body.token;
    const businessId = reg.body.user.business.id;
    const today = dayKey(new Date());

    let rice;
    let oil;

    await step('Route schemas reject malformed IDs, unknown query fields, and injected business IDs', async () => {
      const malformedId = await call('GET', '/api/products/not-an-object-id');
      assert.equal(malformedId.status, 400);
      assert.equal(malformedId.body.code, 'VALIDATION_ERROR');

      const invalidQuery = await call('GET', '/api/products?lowStock=perhaps');
      assert.equal(invalidQuery.status, 400);
      assert.equal(invalidQuery.body.code, 'VALIDATION_ERROR');

      const injected = await call('POST', '/api/products', {
        json: {
          name: 'Injected Product',
          sellingPrice: 10,
          costPrice: 5,
          businessId: '64b000000000000000000000',
        },
      });
      assert.equal(injected.status, 400);
      assert.equal(injected.body.code, 'VALIDATION_ERROR');
      assert.equal(await Product.countDocuments({ name: 'Injected Product' }), 0);
    });

    await step('Opening stock is recorded as a movement (stock = sum of movements)', async () => {
      rice = ok(await call('POST', '/api/products', { json: { name: 'Rice 50kg', unit: 'bag', sellingPrice: 80000, costPrice: 70000, currentStock: 10, minimumStock: 2 } }), 201);
      oil = ok(await call('POST', '/api/products', { json: { name: 'Oil 25L', unit: 'keg', sellingPrice: 50000, costPrice: 40000, currentStock: 2, minimumStock: 1 } }), 201);
      assert.equal(rice.currentStock, 10);
      const moves = await StockMovement.find({ productId: rice._id });
      assert.equal(moves.length, 1);
      assert.equal(moves[0].type, 'adjustment');
      assert.equal(moves[0].quantity, 10);
    });

    await step('Product creation rolls back if its opening-stock movement cannot be recorded', async () => {
      const name = 'Opening Stock Rollback Product';
      const before = await StockMovement.countDocuments({ businessId });
      const originalCreate = StockMovement.create;
      StockMovement.create = async function (...args) {
        if (args[0] && args[0][0] && args[0][0].note === 'Opening stock') {
          throw new Error('Injected opening stock movement failure');
        }
        return originalCreate.apply(this, args);
      };
      let response;
      try {
        response = await call('POST', '/api/products', {
          json: { name, sellingPrice: 100, costPrice: 50, currentStock: 4 },
        });
      } finally {
        StockMovement.create = originalCreate;
      }
      assert.equal(response.status, 500);
      assert.equal(await Product.countDocuments({ businessId, name }), 0);
      assert.equal(await StockMovement.countDocuments({ businessId }), before);
    });

    await step('Product update: stock and unknown fields are refused; allowed fields work', async () => {
      const stock = await call('PUT', `/api/products/${rice._id}`, { json: { currentStock: 999 } });
      assert.equal(stock.status, 400);
      assert.equal(stock.body.code, 'STOCK_NOT_EDITABLE');
      const sneaky = await call('PUT', `/api/products/${rice._id}`, { json: { businessId: '64b000000000000000000000' } });
      assert.equal(sneaky.status, 400);
      assert.equal(sneaky.body.code, 'INVALID_FIELDS');
      const fine = ok(await call('PUT', `/api/products/${rice._id}`, { json: { minimumStock: 3 } }));
      assert.equal(fine.minimumStock, 3);
      assert.equal(String(fine.businessId), businessId);
    });

    await step('Overselling is refused and nothing is deducted (even for earlier lines)', async () => {
      const res = await call('POST', '/api/sales', {
        json: { items: [{ productId: rice._id, quantity: 1 }, { productId: oil._id, quantity: 5 }] },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'INSUFFICIENT_STOCK');
      assert.equal((await Product.findById(rice._id)).currentStock, 10);
      assert.equal((await Product.findById(oil._id)).currentStock, 2);
    });

    await step('Sale validation: credit needs a customer, amountPaid <= total, positive quantities', async () => {
      const stockBefore = (await Product.findById(rice._id)).currentStock;
      const movementsBefore = await StockMovement.countDocuments({ businessId });
      const salesBefore = await Sale.countDocuments({ businessId });
      for (const body of [
        { items: [{ productId: rice._id, quantity: 1 }], amountPaid: 0 },
        { items: [{ productId: rice._id, quantity: 1 }], amountPaid: 1000, total: 80000 },
      ]) {
        const noCustomer = await call('POST', '/api/sales', { json: body });
        assert.equal(noCustomer.status, 400);
        assert.equal(noCustomer.body.code, 'CUSTOMER_REQUIRED');
      }
      assert.equal((await Product.findById(rice._id)).currentStock, stockBefore);
      assert.equal(await StockMovement.countDocuments({ businessId }), movementsBefore);
      assert.equal(await Sale.countDocuments({ businessId }), salesBefore);
      const overpaid = await call('POST', '/api/sales', { json: { items: [{ productId: rice._id, quantity: 1 }], amountPaid: 999999 } });
      assert.equal(overpaid.body.code, 'INVALID_AMOUNT');
      const mismatchedTotal = await call('POST', '/api/sales', { json: { items: [{ productId: rice._id, quantity: 1 }], total: 1 } });
      assert.equal(mismatchedTotal.status, 400);
      assert.equal(mismatchedTotal.body.code, 'TOTAL_MISMATCH');
      const missingPartialAmount = await call('POST', '/api/sales', { json: { items: [{ productId: rice._id, quantity: 1 }], paymentStatus: 'partial', customerName: 'Partial Customer' } });
      assert.equal(missingPartialAmount.status, 400);
      assert.equal(missingPartialAmount.body.code, 'INVALID_AMOUNT');
      const conflictingPaymentStatus = await call('POST', '/api/sales', { json: { items: [{ productId: rice._id, quantity: 1 }], paymentStatus: 'paid', amountPaid: 1000 } });
      assert.equal(conflictingPaymentStatus.status, 400);
      assert.equal(conflictingPaymentStatus.body.code, 'PAYMENT_STATUS_MISMATCH');
      const negative = await call('POST', '/api/sales', { json: { items: [{ productId: rice._id, quantity: -2 }] } });
      assert.equal(negative.body.code, 'INVALID_QUANTITY');
      const badMove = await call('POST', '/api/stock/movements', { json: { productId: rice._id, type: 'stolen', quantity: 1 } });
      assert.equal(badMove.status, 400);
      assert.equal(badMove.body.code, 'INVALID_MOVEMENT_TYPE');
    });

    await step('Manual sale transaction rolls back stock, customer, sale and debt on a mid-write failure', async () => {
      const before = {
        rice: (await Product.findById(rice._id)).currentStock,
        oil: (await Product.findById(oil._id)).currentStock,
        movements: await StockMovement.countDocuments({ businessId }),
        sales: await Sale.countDocuments({ businessId }),
        debts: await Debt.countDocuments({ businessId }),
      };
      const originalCreate = StockMovement.create;
      let calls = 0;
      StockMovement.create = async function (...args) {
        calls += 1;
        if (calls === 2) throw new Error('Injected stock movement failure');
        return originalCreate.apply(this, args);
      };
      let response;
      try {
        response = await call('POST', '/api/sales', {
          json: {
            items: [{ productId: rice._id, quantity: 1 }, { productId: oil._id, quantity: 1 }],
            amountPaid: 0,
            customerName: 'Rollback Customer',
          },
        });
      } finally {
        StockMovement.create = originalCreate;
      }
      assert.equal(response.status, 500);
      assert.equal((await Product.findById(rice._id)).currentStock, before.rice);
      assert.equal((await Product.findById(oil._id)).currentStock, before.oil);
      assert.equal(await StockMovement.countDocuments({ businessId }), before.movements);
      assert.equal(await Sale.countDocuments({ businessId }), before.sales);
      assert.equal(await Debt.countDocuments({ businessId }), before.debts);
      assert.equal(await Customer.countDocuments({ businessId, name: 'Rollback Customer' }), 0);
    });

    await step('Multi-item manual purchase transaction rolls back created products and earlier stock movements', async () => {
      const name = 'Atomic Purchase Product';
      const before = {
        rice: (await Product.findById(rice._id)).currentStock,
        movements: await StockMovement.countDocuments({ businessId }),
        purchases: await Purchase.countDocuments({ businessId }),
      };
      const originalCreate = StockMovement.create;
      let calls = 0;
      StockMovement.create = async function (...args) {
        calls += 1;
        if (calls === 2) throw new Error('Injected stock movement failure');
        return originalCreate.apply(this, args);
      };
      let response;
      try {
        response = await call('POST', '/api/purchases', {
          json: {
            items: [
              { productName: name, quantity: 3, unitCost: 100 },
              { productId: rice._id, quantity: 1, unitCost: 70000 },
            ],
          },
        });
      } finally {
        StockMovement.create = originalCreate;
      }
      assert.equal(response.status, 500);
      assert.equal(await Product.countDocuments({ businessId, name }), 0);
      assert.equal((await Product.findById(rice._id)).currentStock, before.rice);
      assert.equal(await StockMovement.countDocuments({ businessId }), before.movements);
      assert.equal(await Purchase.countDocuments({ businessId }), before.purchases);
    });

    await step('Purchase total must match its item subtotal', async () => {
      const stockBefore = (await Product.findById(rice._id)).currentStock;
      const movementsBefore = await StockMovement.countDocuments({ businessId });
      const purchasesBefore = await Purchase.countDocuments({ businessId });
      const response = await call('POST', '/api/purchases', {
        json: { items: [{ productId: rice._id, quantity: 2, unitCost: 70000 }], total: 1 },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'TOTAL_MISMATCH');
      assert.equal((await Product.findById(rice._id)).currentStock, stockBefore);
      assert.equal(await StockMovement.countDocuments({ businessId }), movementsBefore);
      assert.equal(await Purchase.countDocuments({ businessId }), purchasesBefore);
    });

    // Known activity for today:
    //  sale A: 2 rice paid in full           -> revenue 160,000, cash in 160,000, cogs 140,000
    //  sale B: 1 oil, 20,000 paid, Mama Ngozi -> revenue  50,000, cash in  20,000, cogs  40,000, debt 30,000
    //  debt repayment 10,000                  -> cash in 10,000
    //  expense transport 5,000                -> cash out 5,000
    //  purchase 3 rice @ 70,000               -> cash out 210,000
    await step('Record known transactions through the API', async () => {
      ok(await call('POST', '/api/sales', { json: { items: [{ productId: rice._id, quantity: 2 }] } }), 201);
      const credit = ok(await call('POST', '/api/sales', { json: { items: [{ productId: oil._id, quantity: 1 }], amountPaid: 20000, customerName: 'Mama Ngozi' } }), 201);
      assert.equal(credit.debtCreated.amount, 30000);
      ok(await call('POST', '/api/debts/payments', { json: { debtId: credit.debtCreated._id, amount: 10000 } }));
      ok(await call('POST', '/api/expenses', { json: { category: 'transport', amount: 5000 } }), 201);
      ok(await call('POST', '/api/purchases', { json: { supplier: 'Alaba', items: [{ productId: rice._id, quantity: 3, unitCost: 70000 }] } }), 201);
    });

    await step('Profit & loss matches the records exactly', async () => {
      const pl = ok(await call('GET', `/api/reports/profit-loss?from=${today}&to=${today}`));
      assert.equal(pl.salesCount, 2);
      assert.equal(pl.revenue, 210000);
      assert.equal(pl.cogs, 180000);
      assert.equal(pl.grossProfit, 30000);
      assert.equal(pl.expenses.total, 5000);
      assert.equal(pl.expenses.byCategory.transport, 5000);
      assert.equal(pl.netProfit, 25000);
      assert.equal(pl.byProduct[0].name, 'Rice 50kg');
    });

    await step('Cash flow (daily) includes receipts, repayments, expenses and purchases', async () => {
      const cf = ok(await call('GET', '/api/reports/cash-flow?interval=day'));
      assert.equal(cf.series.length, 30, 'default range is 30 days, one row per day');
      const t = cf.totals;
      assert.equal(t.salesReceipts, 180000);
      assert.equal(t.debtRepayments, 10000);
      assert.equal(t.expenses, 5000);
      assert.equal(t.purchases, 210000);
      assert.equal(t.net, 190000 - 215000);
      assert.equal(cf.series[cf.series.length - 1].period, today);
      assert.equal(cf.series[cf.series.length - 1].cumulativeNet, -25000);

      const weekly = ok(await call('GET', '/api/reports/cash-flow?interval=week'));
      assert.equal(weekly.totals.net, -25000);
      assert.ok(weekly.series.length >= 5 && weekly.series.length <= 6);
    });

    await step('Dashboard cash position agrees with the cash-flow report', async () => {
      const dash = ok(await call('GET', '/api/dashboard?timeRange=today'));
      assert.equal(dash.cashPosition, -25000);
      assert.equal(dash.cashFlow.purchases, 210000);
      assert.equal(dash.cashFlow.debtRepayments, 10000);
    });

    await step('Top products, sales rate and daily sales feeds', async () => {
      const top = ok(await call('GET', '/api/reports/top-products?by=quantity&limit=1'));
      assert.equal(top.products.length, 1);
      assert.equal(top.products[0].name, 'Rice 50kg');
      assert.equal(top.products[0].rank, 1);

      const rate = ok(await call('GET', '/api/reports/sales-rate?days=14'));
      const riceRate = rate.products.find((p) => p.name === 'Rice 50kg');
      assert.equal(riceRate.unitsSold, 2);
      assert.equal(riceRate.currentStock, 11); // 10 opening - 2 sold + 3 purchased
      assert.equal(riceRate.avgDailyUnits, 0.14);
      assert.equal(riceRate.daysOfStockLeft, 78.57);

      const daily = ok(await call('GET', '/api/reports/daily-sales?days=7'));
      assert.equal(daily.series.length, 7);
      const todayRow = daily.series[daily.series.length - 1];
      assert.equal(todayRow.date, today);
      assert.equal(todayRow.revenue, 210000);
      assert.equal(todayRow.units, 3);
      assert.equal(daily.byWeekday.length, 7);

      const oilOnly = ok(await call('GET', `/api/reports/daily-sales?days=7&productId=${oil._id}`));
      assert.equal(oilOnly.series[oilOnly.series.length - 1].revenue, 50000);
    });

    await step('Invalid report parameters -> 400', async () => {
      for (const q of ['cash-flow?interval=month', 'profit-loss?from=2026-10-09&to=2026-10-01', 'profit-loss?from=yesterday', 'top-products?by=colour', 'sales-rate?days=0']) {
        const res = await call('GET', `/api/reports/${q}`);
        assert.equal(res.status, 400, q);
      }
    });

    await step('ML service can read reports with X-API-Key + X-Business-Id (and only that business)', async () => {
      const key = process.env.INTERNAL_SERVICE_API_KEY;
      const viaService = await call('GET', '/api/reports/profit-loss', { headers: { 'X-API-Key': key, 'X-Business-Id': businessId } });
      assert.equal(viaService.status, 200);
      assert.equal(viaService.body.data.revenue, 210000);

      const wrongKey = await call('GET', '/api/reports/profit-loss', { headers: { 'X-API-Key': 'nope', 'X-Business-Id': businessId } });
      assert.equal(wrongKey.status, 401);
      assert.equal(wrongKey.body.code, 'SERVICE_KEY_INVALID');
      const noBusiness = await call('GET', '/api/reports/profit-loss', { headers: { 'X-API-Key': key } });
      assert.equal(noBusiness.status, 400);
      const notReports = await call('GET', '/api/products', { headers: { 'X-API-Key': key, 'X-Business-Id': businessId } });
      assert.equal(notReports.status, 401, 'the service key only opens the read-only reports');

      delete process.env.INTERNAL_SERVICE_API_KEY;
      const disabled = await call('GET', '/api/reports/profit-loss', { headers: { 'X-API-Key': key, 'X-Business-Id': businessId } });
      assert.equal(disabled.status, 401, 'no key configured = service access disabled');
    });

    console.log('\nALL REPORTS TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Reports test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await disconnectDB();
  }
};

run();
