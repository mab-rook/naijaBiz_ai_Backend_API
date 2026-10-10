const http = require('http');
const dotenv = require('dotenv');
const path = require('path');

// This suite exercises the local (offline) AI fallback; tests/ml.test.js covers the ML service path
process.env.ML_SERVICE_URL = '';
dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';

const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');

let server;
let baseUrl;

const request = (method, endpoint, body = null, token = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
};

const runTests = async () => {
  console.log('Starting NaijaBiz AI Backend Integration Tests...\n');

  try {
    // 1. Connect and Seed Database
    await connectDB();
    await seedDatabase();

    // 2. Start Test Server on free port
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
    console.log(`Test server running on ${baseUrl}\n`);

    // TEST 1: Auth Login
    console.log('--- Test 1: Merchant Auth Login ---');
    const loginRes = await request('POST', '/api/auth/login', {
      phone: '08023456789',
      password: 'password123',
    });
    console.assert(loginRes.status === 200, `Expected 200, got ${loginRes.status}`);
    console.assert(loginRes.body.token, 'Expected JWT token');
    const token = loginRes.body.token;
    console.log(`PASS Auth login passed: Merchant "${loginRes.body.user.name}" logged in.\n`);

    // TEST 2: Dashboard Metrics
    console.log('--- Test 2: Dashboard Metrics ---');
    const dashRes = await request('GET', '/api/dashboard', null, token);
    console.assert(dashRes.status === 200, 'Expected 200 from dashboard');
    console.assert(dashRes.body.data.revenue.total > 0, 'Expected positive revenue');
    console.assert(dashRes.body.data.inventory.stockCostValue > 0, 'Expected positive inventory value');
    console.log(`PASS Dashboard verified:`);
    console.log(`   - Total Revenue: ₦${dashRes.body.data.revenue.total.toLocaleString()}`);
    console.log(`   - Stock Cost Value: ₦${dashRes.body.data.inventory.stockCostValue.toLocaleString()}`);
    console.log(`   - Outstanding Debts: ₦${dashRes.body.data.debts.totalOutstanding.toLocaleString()}\n`);

    // TEST 3: Debt Ledger and Multilingual Reminders
    console.log('--- Test 3: Customer Debt Ledger & Ageing ---');
    const debtsRes = await request('GET', '/api/debts', null, token);
    console.assert(debtsRes.status === 200, 'Expected 200 from debts');
    console.assert(debtsRes.body.data.activeDebtorsCount > 0, 'Expected active debtors');
    const firstDebt = debtsRes.body.data.debts[0];
    console.log(`PASS Debt ledger verified: ${debtsRes.body.data.activeDebtorsCount} debtors.`);
    console.log(`   - Ageing Breakdown:`, debtsRes.body.data.ageingSummary);

    // Multilingual Reminder Draft
    const reminderRes = await request('GET', `/api/debts/reminders/${firstDebt._id}?language=yo`, null, token);
    console.assert(reminderRes.status === 200, 'Expected 200 from reminder draft');
    console.log(`PASS Yoruba Debt Reminder Draft: "${reminderRes.body.data.message}"\n`);

    // TEST 4: AI Voice Command (Proposed action created, Confirm-then-Commit verified)
    console.log('--- Test 4: AI Voice Command & Confirm-Then-Commit Pattern ---');
    const voiceRes = await request('POST', '/api/ai/voice', {
      transcript: 'I bought 50 bags of rice for 4 million naira',
      language: 'en',
    }, token);

    console.assert(voiceRes.status === 200, 'Expected 200 from AI voice');
    console.assert(voiceRes.body.data.intent === 'add_inventory', 'Expected intent add_inventory');
    console.assert(voiceRes.body.data.status === 'proposed', 'Action MUST start as "proposed"');
    console.assert(voiceRes.body.data.entities.quantity === 50, 'Expected quantity 50');
    console.assert(voiceRes.body.data.entities.unitCost === 80000, 'Expected unit cost ₦80,000');
    console.log(`PASS AI Action Proposed:`);
    console.log(`   - Confirmation Card Message: "${voiceRes.body.data.confirmationMessage}"`);
    console.log(`   - Action Status: ${voiceRes.body.data.status}`);

    const actionId = voiceRes.body.actionId;

    // Verify stock is NOT updated yet (Confirm-then-commit)
    const stockBefore = await request('GET', '/api/stock', null, token);
    const riceBefore = stockBefore.body.data.products.find((p) => p.name.includes('Rice'));
    const stockQtyBefore = riceBefore.currentStock;
    console.log(`   - Stock of Rice BEFORE confirmation: ${stockQtyBefore} bags (Unchanged)`);

    // Now Confirm the action
    const confirmRes = await request('POST', `/api/ai/actions/${actionId}/confirm`, null, token);
    console.assert(confirmRes.status === 200, 'Expected 200 from confirm');
    console.assert(confirmRes.body.data.aiAction.status === 'confirmed', 'Action MUST be confirmed');

    // Verify stock IS updated now
    const stockAfter = await request('GET', '/api/stock', null, token);
    const riceAfter = stockAfter.body.data.products.find((p) => p.name.includes('Rice'));
    console.assert(riceAfter.currentStock === stockQtyBefore + 50, 'Stock should have increased by 50');
    console.log(`PASS AI Action Confirmed: Stock increased from ${stockQtyBefore} to ${riceAfter.currentStock} bags!\n`);

    // TEST 5: AI Rejection Pattern
    console.log('--- Test 5: AI Action Rejection Pattern ---');
    const rejectVoiceRes = await request('POST', '/api/ai/voice', {
      transcript: 'I bought 100 cartons of Indomie for 800,000 naira',
      language: 'en',
    }, token);
    const rejectActionId = rejectVoiceRes.body.actionId;

    const rejectRes = await request('POST', `/api/ai/actions/${rejectActionId}/reject`, null, token);
    console.assert(rejectRes.status === 200, 'Expected 200 from reject');
    console.assert(rejectRes.body.data.status === 'rejected', 'Expected status to be rejected');
    console.log(`PASS Action rejected successfully. No inventory or transactions created.\n`);

    // TEST 6: Receipt OCR Ingestion
    console.log('--- Test 6: Receipt Photo Ingestion (Demo Supplier Invoice) ---');
    const receiptRes = await request('POST', '/api/ai/receipt', {
      receiptImageUrl: 'https://demo.naijabiz.ai/invoices/demo_invoice_01.jpg',
    }, token);

    console.assert(receiptRes.status === 200, 'Expected 200 from receipt');
    console.assert(receiptRes.body.data.entities.items.length === 3, 'Expected 3 items extracted');
    console.log(`PASS Demo Receipt Parsed:`);
    console.log(`   - Items Extracted: ${receiptRes.body.data.entities.items.map((i) => `${i.quantity} ${i.unit} ${i.productName}`).join(', ')}`);
    console.log(`   - Confirmation Card: "${receiptRes.body.data.confirmationMessage}"\n`);

    // TEST 7: Ask My Business (Natural Language Queries)
    console.log('--- Test 7: "Ask My Business" Intelligent Q&A ---');

    // 7a: Stock question
    const q1 = await request('POST', '/api/ai/ask', {
      query: 'How much rice do I have left?',
      language: 'en',
    }, token);
    console.log(`Q: "How much rice do I have left?"`);
    console.log(`A: "${q1.body.data.answer}"\n`);

    // 7b: Yoruba Language stock question
    const q2 = await request('POST', '/api/ai/ask', {
      query: 'Elo iresi lo ku?',
      language: 'yo',
    }, token);
    console.log(`Q: "Elo iresi lo ku?" (Yoruba)`);
    console.log(`A: "${q2.body.data.answer}"\n`);

    // 7c: Profit question
    const q3 = await request('POST', '/api/ai/ask', {
      query: 'What was my profit last month?',
      language: 'en',
    }, token);
    console.log(`Q: "What was my profit last month?"`);
    console.log(`A: "${q3.body.data.answer}"\n`);

    // 7d: Affordability question ("Can I afford a freezer?")
    const q4 = await request('POST', '/api/ai/ask', {
      query: 'Can I afford to buy another freezer for 250,000 naira?',
      language: 'en',
    }, token);
    console.log(`Q: "Can I afford to buy another freezer?"`);
    console.log(`A: "${q4.body.data.answer}"\n`);

    // TEST 8: Proactive Alerts
    console.log('--- Test 8: Proactive Alerts Feed ---');
    const alertsRes = await request('GET', '/api/alerts', null, token);
    console.assert(alertsRes.status === 200, 'Expected 200 from alerts');
    console.assert(alertsRes.body.data.length > 0, 'Expected alerts generated');
    console.log(`PASS Active Proactive Alerts (${alertsRes.body.count}):`);
    alertsRes.body.data.slice(0, 3).forEach((a) => {
      console.log(`   - [${a.severity.toUpperCase()}] ${a.title}: ${a.message}`);
    });

    console.log('\nALL INTEGRATION TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    await disconnectDB();
  }
};

runTests();
