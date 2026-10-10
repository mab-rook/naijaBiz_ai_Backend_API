/**
 * The hackathon demo script (project document, "Demo script") against the seeded demo shop,
 * using the local AI fallback so it works with no ML service. Also checks the seed itself:
 * stock must equal the sum of stock movements, and sales-rate figures must be realistic.
 */
const http = require('http');
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test'; // isolated in-memory database: the seed wipes every collection
process.env.ML_SERVICE_URL = '';
process.env.DEMO_MODE = 'false';

const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
const Product = require('../modules/products/productModel');
const StockMovement = require('../modules/inventory/stockMovementModel');

let server;
let baseUrl;
let token;

const api = async (method, endpoint, json) => {
  const headers = { Authorization: `Bearer ${token}` };
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${endpoint}`, { method, headers, body: json ? JSON.stringify(json) : undefined });
  const body = await res.json();
  assert.ok(res.status < 300, `${method} ${endpoint} -> ${res.status} ${JSON.stringify(body)}`);
  return body.data;
};

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('Demo script tests\n');
  try {
    await connectDB();
    await seedDatabase();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '08023456789', password: 'password123' }),
    }).then((r) => r.json());
    token = login.token;

    await step('Seed: every product\'s stock equals the sum of its stock movements', async () => {
      for (const product of await Product.find()) {
        const [sum] = await StockMovement.aggregate([
          { $match: { productId: product._id } },
          { $group: { _id: null, total: { $sum: '$quantity' } } },
        ]);
        assert.equal(sum ? sum.total : 0, product.currentStock, product.name);
      }
    });

    await step('Seed: sales rate is realistic (rice has weeks, not 999 days, of stock)', async () => {
      const rate = await api('GET', '/api/reports/sales-rate');
      const rice = rate.products.find((p) => /rice/i.test(p.name));
      assert.ok(rice.avgDailyUnits > 0);
      assert.ok(rice.daysOfStockLeft > 7 && rice.daysOfStockLeft < 60, `rice days left ${rice.daysOfStockLeft}`);
      const daily = await api('GET', '/api/reports/daily-sales?days=28');
      const avg = Object.fromEntries(daily.byWeekday.map((d) => [d.dayOfWeek, d.avgRevenue]));
      assert.ok(avg.Saturday > avg.Tuesday, 'Saturdays should be busier than Tuesdays');
    });

    let riceBefore;
    await step('1-3. Photograph supplier invoice, review items, confirm: stock goes up', async () => {
      riceBefore = (await Product.findOne({ name: /rice/i })).currentStock;
      const proposal = await api('POST', '/api/ai/receipt', {});
      assert.equal(proposal.intent, 'add_inventory');
      assert.equal(proposal.entities.items.length, 3);
      await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal((await Product.findOne({ name: /rice/i })).currentStock, riceBefore + 20);
    });

    await step('4. "How much rice do I have left?" gives stock and realistic days remaining', async () => {
      const res = await api('POST', '/api/ai/ask', { query: 'How much rice do I have left?', language: 'en' });
      assert.equal(res.data.currentStock, riceBefore + 20);
      assert.ok(res.data.daysRemaining > 7 && res.data.daysRemaining < 999, `days ${res.data.daysRemaining}`);
    });

    await step('Language moment: the same question in Yoruba is answered in Yoruba', async () => {
      const res = await api('POST', '/api/ai/ask', { query: 'Elo iresi lo ku?', language: 'yo' });
      assert.match(res.answer, /^O ku /);
    });

    await step('5. "Can I afford to buy another freezer?" gives cash-flow based advice', async () => {
      const res = await api('POST', '/api/ai/ask', { query: 'Can I afford to buy another freezer?', language: 'en' });
      assert.equal(res.category, 'affordability_check');
      assert.ok(['SAFE_TO_BUY', 'PROCEED_WITH_CAUTION', 'NOT_RECOMMENDED'].includes(res.data.verdict));
    });

    await step('6. Proactive alerts: low stock, restock, sales drop, overdue debt and weekend-demand insight', async () => {
      const alerts = await api('GET', '/api/alerts');
      const types = new Set(alerts.map((a) => a.type));
      for (const type of ['low_stock', 'restock_suggestion', 'sales_drop', 'overdue_debt', 'insight']) {
        assert.ok(types.has(type), `missing ${type} alert`);
      }
    });

    await step('Voice phrase "I just sold five bottles of Coke" can be confirmed', async () => {
      const coke = await Product.findOne({ name: /coca-cola/i });
      const proposal = await api('POST', '/api/ai/voice', { transcript: 'I just sold five bottles of Coke', language: 'en' });
      assert.equal(proposal.intent, 'record_sale');
      assert.equal(proposal.entities.quantity, 5);
      await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal((await Product.findById(coke._id)).currentStock, coke.currentStock - 5);
    });

    await step('Dashboard figures match the profit & loss report for the same records', async () => {
      const dash = await api('GET', '/api/dashboard?timeRange=today');
      const today = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
      const pl = await api('GET', `/api/reports/profit-loss?from=${today}&to=${today}`);
      assert.equal(dash.revenue.today, pl.revenue);
    });

    console.log('\nALL DEMO SCRIPT TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Demo script test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await disconnectDB();
  }
};

run();
