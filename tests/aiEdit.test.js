/**
 * Confirmation card "Edit" step + confirm/reject safety (atomic claim, status codes).
 * Uses the local AI parser so results are deterministic.
 */
const http = require('http');
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';
process.env.ML_SERVICE_URL = '';
process.env.DEMO_MODE = 'false';

const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
const Product = require('../modules/products/productModel');
const Sale = require('../modules/sales/saleModel');
const Purchase = require('../modules/purchases/purchaseModel');
const Debt = require('../modules/debts/debtModel');
const AIAction = require('../modules/ai/aiActionModel');
const StockMovement = require('../modules/inventory/stockMovementModel');

let server;
let baseUrl;
let token;

const api = async (method, endpoint, json) => {
  const headers = { Authorization: `Bearer ${token}` };
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${endpoint}`, { method, headers, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, body: await res.json() };
};

const propose = async (text, language = 'en') => {
  const res = await api('POST', '/api/ai/text', { text, language });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('AI action Edit tests\n');
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

    const rice = await Product.findOne({ name: /rice/i });

    await step('Edit quantity: unit cost and confirmation message are recalculated, then confirm uses the edit', async () => {
      const proposal = await propose('I bought 50 bags of rice for 4 million naira');
      const edit = await api('PATCH', `/api/ai/actions/${proposal.id}`, { entities: { quantity: 40 } });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.equal(edit.body.data.entities.quantity, 40);
      assert.equal(edit.body.data.entities.unitCost, 100000);
      assert.equal(edit.body.data.edited, true);
      assert.match(edit.body.data.confirmationMessage, /Add 40 bag/);

      const before = (await Product.findById(rice._id)).currentStock;
      const confirm = await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal(confirm.status, 200);
      assert.equal((await Product.findById(rice._id)).currentStock, before + 40);

      const stored = await AIAction.findById(proposal.id);
      assert.equal(stored.editHistory.length, 1);
      assert.equal(stored.editHistory[0].before.entities.quantity, 50);
      assert.equal(stored.editHistory[0].after.entities.quantity, 40);
    });

    await step('Edit receipt lines: drop a line, fix a quantity, add a new product', async () => {
      const receipt = await api('POST', '/api/ai/receipt', {});
      const items = receipt.body.data.entities.items;
      const edited = [
        { productName: items[0].productName, quantity: 18, unit: 'bag', unitCost: items[0].unitCost },
        { productName: 'Peak Milk Tin 400g', quantity: 24, unit: 'tin', unitCost: 2500 },
      ];
      const edit = await api('PATCH', `/api/ai/actions/${receipt.body.data.id}`, { entities: { items: edited } });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.equal(edit.body.data.entities.items.length, 2);
      assert.equal(edit.body.data.entities.totalAmount, 18 * items[0].unitCost + 24 * 2500);
      assert.equal(String(edit.body.data.entities.items[0].productId), String(rice._id));
      assert.equal(edit.body.data.entities.items[1].productId, null);

      const confirm = await api('POST', `/api/ai/actions/${receipt.body.data.id}/confirm`);
      assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
      const purchase = await Purchase.findById(confirm.body.data.executionResult.purchaseId);
      assert.equal(purchase.items.length, 2);
      assert.equal(purchase.total, 18 * items[0].unitCost + 24 * 2500);
      const milk = await Product.findOne({ name: 'Peak Milk Tin 400g' });
      assert.equal(milk.currentStock, 24);
    });

    await step('A failed multi-item AI confirm rolls back every write and keeps the action retryable', async () => {
      const receipt = await api('POST', '/api/ai/receipt', {});
      assert.equal(receipt.status, 200);
      const businessId = rice.businessId;
      const productsBefore = await Product.find({ businessId }).select('_id currentStock').lean();
      const movementsBefore = await StockMovement.countDocuments({ businessId });
      const purchasesBefore = await Purchase.countDocuments({ businessId });
      const originalCreate = StockMovement.create;
      let calls = 0;
      StockMovement.create = async function (...args) {
        calls += 1;
        if (calls === 2) throw new Error('Injected stock movement failure');
        return originalCreate.apply(this, args);
      };
      let confirm;
      try {
        confirm = await api('POST', `/api/ai/actions/${receipt.body.data.id}/confirm`);
      } finally {
        StockMovement.create = originalCreate;
      }
      assert.equal(confirm.status, 500);
      const productsAfter = await Product.find({ businessId }).select('_id currentStock').lean();
      assert.deepEqual(
        productsAfter.map(({ _id, currentStock }) => [String(_id), currentStock]),
        productsBefore.map(({ _id, currentStock }) => [String(_id), currentStock])
      );
      assert.equal(await StockMovement.countDocuments({ businessId }), movementsBefore);
      assert.equal(await Purchase.countDocuments({ businessId }), purchasesBefore);
      assert.equal((await AIAction.findById(receipt.body.data.id)).status, 'proposed');
    });

    await step('Credit sale without customer is blocked on confirm, fixed via Edit, then creates the debt', async () => {
      const proposal = await propose('I sold 2 bags of rice on credit');
      assert.equal(proposal.intent, 'record_sale');
      assert.equal(proposal.entities.paymentStatus, 'unpaid');

      const blocked = await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal(blocked.status, 422);
      assert.equal(blocked.body.code, 'CUSTOMER_REQUIRED');
      assert.equal((await AIAction.findById(proposal.id)).status, 'proposed', 'failed confirm must release the action');

      const edit = await api('PATCH', `/api/ai/actions/${proposal.id}`, { entities: { customer: 'Mama Tunde' } });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.match(edit.body.data.confirmationMessage, /credit: Mama Tunde/);

      const confirm = await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
      const debt = await Debt.findById(confirm.body.data.executionResult.debtId);
      assert.ok(debt && debt.amount > 0);
    });

    await step('Part-paid AI sale records the payment and outstanding debt balance', async () => {
      const proposal = await propose('I sold 2 bags of rice');
      assert.equal(proposal.intent, 'record_sale');
      const edit = await api('PATCH', `/api/ai/actions/${proposal.id}`, {
        entities: {
          totalAmount: 3000,
          amountPaid: 1000,
          paymentStatus: 'partial',
          customer: 'Chika Okafor',
        },
      });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.match(edit.body.data.confirmationMessage, /paid ₦1,000, balance ₦2,000/);

      const confirm = await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
      const sale = await Sale.findById(confirm.body.data.executionResult.saleId);
      const debt = await Debt.findById(confirm.body.data.executionResult.debtId);
      assert.equal(sale.total, 3000);
      assert.equal(sale.amountPaid, 1000);
      assert.equal(sale.paymentStatus, 'partial');
      assert.equal(debt.amount, 2000);
    });

    await step('Changing the intent starts from clean fields (purchase misheard -> expense)', async () => {
      const proposal = await propose('I bought 3 bags of rice for 240000 naira');
      const edit = await api('PATCH', `/api/ai/actions/${proposal.id}`, {
        intent: 'record_expense',
        entities: { totalAmount: 15000, category: 'transport', note: 'Okada to market' },
      });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.equal(edit.body.data.intent, 'record_expense');
      assert.equal(edit.body.data.entities.product, null);
      const confirm = await api('POST', `/api/ai/actions/${proposal.id}/confirm`);
      assert.equal(confirm.body.data.executionResult.type, 'expense');
      assert.equal(confirm.body.data.executionResult.amount, 15000);
    });

    await step('Confirmation message is regenerated in the merchant\'s language', async () => {
      const proposal = await propose('Mo ra apo iresi 10 fun 800000 naira', 'yo');
      const edit = await api('PATCH', `/api/ai/actions/${proposal.id}`, { entities: { quantity: 8 } });
      assert.match(edit.body.data.confirmationMessage, /^Se ki n se afikun 8/);
    });

    await step('Invalid edits are rejected with 400 / 422 and change nothing', async () => {
      const proposal = await propose('I bought 5 bags of rice for 400000 naira');
      const cases = [
        [{ entities: { quantity: -3 } }, 400, 'INVALID_EDIT'],
        [{ entities: { category: 'rent' } }, 400, 'INVALID_EDIT'], // not editable for add_inventory
        [{ entities: { items: [] } }, 400, 'INVALID_EDIT'],
        [{ intent: 'query' }, 400, 'INVALID_EDIT'],
        [{}, 400, 'INVALID_EDIT'],
      ];
      for (const [body, status, code] of cases) {
        const res = await api('PATCH', `/api/ai/actions/${proposal.id}`, body);
        assert.equal(res.status, status, JSON.stringify(body));
        assert.equal(res.body.code, code);
      }
      const sale = await propose('I sold 2 bags of rice');
      const unknownProduct = await api('PATCH', `/api/ai/actions/${sale.id}`, { entities: { product: 'Golden Penny Spaghetti' } });
      assert.equal(unknownProduct.status, 422);
      assert.equal(unknownProduct.body.code, 'PRODUCT_NOT_FOUND');
      assert.equal((await AIAction.findById(proposal.id)).editHistory.length, 0);
    });

    await step('Edit/confirm/reject on a finished or missing action -> 409 / 404', async () => {
      const proposal = await propose('I paid 5000 for transport');
      await api('POST', `/api/ai/actions/${proposal.id}/reject`);
      for (const [method, suffix] of [['PATCH', ''], ['POST', '/confirm'], ['POST', '/reject']]) {
        const res = await api(method, `/api/ai/actions/${proposal.id}${suffix}`, method === 'PATCH' ? { entities: { totalAmount: 1 } } : undefined);
        assert.equal(res.status, 409, `${method} ${suffix}`);
        assert.equal(res.body.code, 'ACTION_NOT_PENDING');
      }
      const missing = await api('POST', '/api/ai/actions/64b000000000000000000000/confirm');
      assert.equal(missing.status, 404);
      assert.equal(missing.body.code, 'ACTION_NOT_FOUND');
    });

    await step('Double-tapping Confirm writes the stock change only once', async () => {
      const proposal = await propose('I bought 7 bags of rice for 560000 naira');
      const before = (await Product.findById(rice._id)).currentStock;
      const results = await Promise.all([
        api('POST', `/api/ai/actions/${proposal.id}/confirm`),
        api('POST', `/api/ai/actions/${proposal.id}/confirm`),
        api('POST', `/api/ai/actions/${proposal.id}/confirm`),
      ]);
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 409, 409]);
      assert.equal((await Product.findById(rice._id)).currentStock, before + 7);
    });

    await step('GET /ai/actions/:id returns the card with edit history', async () => {
      const proposal = await propose('I paid 12000 for power');
      await api('PATCH', `/api/ai/actions/${proposal.id}`, { entities: { totalAmount: 10000 } });
      const res = await api('GET', `/api/ai/actions/${proposal.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.entities.totalAmount, 10000);
      assert.equal(res.body.data.editHistory.length, 1);
    });

    console.log('\nALL EDIT TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Edit test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await disconnectDB();
  }
};

run();
