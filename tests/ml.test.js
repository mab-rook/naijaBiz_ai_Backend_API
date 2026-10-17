/**
 * ML service integration tests: runs the backend against tests/helpers/mlMockServer.js, then
 * stops the mock to prove every AI endpoint falls back to the local parser.
 */
const http = require('http');
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';

const { createMockMlApp } = require('./helpers/mlMockServer');
const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
const mlService = require('../modules/ai/mlService');
const Product = require('../modules/products/productModel');
const Debt = require('../modules/debts/debtModel');
const Customer = require('../modules/debts/customerModel');
const AIAction = require('../modules/ai/aiActionModel');

for (const key of ['CLOUDINARY_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  delete process.env[key];
}

let apiServer;
let mlServer;
let baseUrl;
let token;
const startedAt = Date.now();
const uploadDir = path.join(__dirname, '../uploads');

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });

const api = async (method, endpoint, { json, form } = {}) => {
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (form) {
    body = form;
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}${endpoint}`, { method, headers, body });
  return { status: res.status, body: await res.json() };
};

const fileForm = (field, filename, type, extra = {}) => {
  const form = new FormData();
  let content = Buffer.from('fake-binary-content');
  if (type === 'audio/mp4') {
    content = Buffer.alloc(24);
    content.writeUInt32BE(24, 0);
    content.write('ftyp', 4);
    content.write('M4A ', 8);
  } else if (type === 'image/jpeg') {
    content = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  }
  form.append(field, new Blob([content], { type }), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
};

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('ML integration tests\n');
  try {
    mlServer = await listen(createMockMlApp());
    process.env.ML_SERVICE_URL = `http://localhost:${mlServer.address().port}`;
    process.env.ML_TIMEOUT_MS = '3000';

    await connectDB();
    await seedDatabase();
    apiServer = await listen(app);
    baseUrl = `http://localhost:${apiServer.address().port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '08023456789', password: 'password123' }),
    }).then((r) => r.json());
    token = login.token;
    assert.ok(token, 'login should return a token');

    const rice = await Product.findOne({ name: /rice/i });

    await step('Uploads require auth, accepted MIME and matching file signatures, and are not public', async () => {
      const form = fileForm('image', 'invoice.jpg', 'image/jpeg');
      const unauthorized = await fetch(`${baseUrl}/api/ai/receipt`, { method: 'POST', body: form });
      assert.equal(unauthorized.status, 401);

      const before = new Set(fs.readdirSync(uploadDir));
      const invalidForm = new FormData();
      invalidForm.append('image', new Blob([Buffer.from('not an image')], { type: 'image/jpeg' }), 'fake.jpg');
      const invalid = await api('POST', '/api/ai/receipt', { form: invalidForm });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, 'INVALID_UPLOAD_CONTENT');
      assert.deepEqual(fs.readdirSync(uploadDir).filter((filename) => !before.has(filename)), []);

      const unsupportedForm = new FormData();
      unsupportedForm.append('image', new Blob([Buffer.from('pdf')], { type: 'application/pdf' }), 'invoice.pdf');
      const unsupported = await api('POST', '/api/ai/receipt', { form: unsupportedForm });
      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.body.code, 'UNSUPPORTED_UPLOAD_TYPE');
    });

    await step('Production upload storage rejects missing or partial Cloudinary credentials', async () => {
      const credentialNames = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
      const savedCredentials = Object.fromEntries(credentialNames.map((name) => [name, process.env[name]]));
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        credentialNames.forEach((name) => delete process.env[name]);
        process.env.NODE_ENV = 'production';
        await assert.rejects(
          require('../modules/ai/mediaStorageService').storeUpload(
            { path: 'unused', mimetype: 'image/jpeg' },
            'business-id'
          ),
          (error) => error.statusCode === 503 && error.code === 'MEDIA_STORAGE_UNAVAILABLE'
        );
        process.env.CLOUDINARY_CLOUD_NAME = 'configured';
        await assert.rejects(
          require('../modules/ai/mediaStorageService').storeUpload(
            { path: 'unused', mimetype: 'image/jpeg' },
            'business-id'
          ),
          (error) => error.statusCode === 503 && error.code === 'MEDIA_STORAGE_UNAVAILABLE'
        );
      } finally {
        credentialNames.forEach((name) => {
          if (savedCredentials[name] === undefined) delete process.env[name];
          else process.env[name] = savedCredentials[name];
        });
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    });

    await step('Text command is interpreted by the ML service and product id is resolved', async () => {
      const res = await api('POST', '/api/ai/text', { json: { text: 'I bought 10 bags of rice for 800,000 naira', language: 'en' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.engine, 'ml');
      assert.equal(res.body.data.intent, 'add_inventory');
      assert.equal(String(res.body.data.entities.productId), String(rice._id));
      assert.equal(res.body.data.entities.unitCost, 80000);

      const before = (await Product.findById(rice._id)).currentStock;
      const confirm = await api('POST', `/api/ai/actions/${res.body.data.id}/confirm`);
      assert.equal(confirm.status, 200);
      const after = (await Product.findById(rice._id)).currentStock;
      assert.equal(after, before + 10);
    });

    await step('Voice note is transcribed by the ML service (Yoruba)', async () => {
      const res = await api('POST', '/api/ai/voice', { form: fileForm('audio', 'note.m4a', 'audio/mp4', { language: 'yo' }) });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.engine, 'ml');
      assert.match(res.body.data.transcript, /iresi/);
      assert.equal(res.body.data.language, 'yo');
      assert.equal(res.body.data.intent, 'add_inventory');
      assert.equal(typeof res.body.data.mediaUrl, 'string');

      const action = await AIAction.findById(res.body.data.id);
      assert.equal(action.media.provider, 'local', 'tests without Cloudinary use private local storage');
      const publicResponse = await fetch(`${baseUrl}/uploads/${action.media.fileName}`);
      assert.equal(publicResponse.status, 404, 'uploaded audio must not be served publicly');
      const mediaResponse = await fetch(`${baseUrl}${res.body.data.mediaUrl}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(mediaResponse.status, 200, 'business owner can retrieve the private media through the API');
      assert.equal(mediaResponse.headers.get('content-type'), 'audio/mp4');
      const anonymousResponse = await fetch(`${baseUrl}${res.body.data.mediaUrl}`);
      assert.equal(anonymousResponse.status, 401, 'private media cannot be retrieved anonymously');

      const otherUser = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Other Shop', phone: '08011113333', password: 'secret123' }),
      }).then((response) => response.json());
      const otherBusinessResponse = await fetch(`${baseUrl}${res.body.data.mediaUrl}`, {
        headers: { Authorization: `Bearer ${otherUser.token}` },
      });
      assert.equal(otherBusinessResponse.status, 404, 'media from another business is not disclosed');
    });

    await step('Receipt photo is parsed by the ML service and confirmed into inventory', async () => {
      const res = await api('POST', '/api/ai/receipt', { form: fileForm('image', 'invoice.jpg', 'image/jpeg') });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.engine, 'ml');
      assert.equal(res.body.data.entities.items.length, 3);
      assert.ok(res.body.data.entities.items.every((it) => it.productName && it.productId));
      const mediaResponse = await fetch(`${baseUrl}${res.body.data.mediaUrl}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(mediaResponse.status, 200);
      assert.equal(mediaResponse.headers.get('content-type'), 'image/jpeg');

      const confirm = await api('POST', `/api/ai/actions/${res.body.data.id}/confirm`);
      assert.equal(confirm.status, 200);
      assert.equal(confirm.body.data.executionResult.itemsCount, 3);
      const Purchase = require('../modules/purchases/purchaseModel');
      const purchase = await Purchase.findById(confirm.body.data.executionResult.purchaseId);
      assert.equal(purchase.receiptImageUrl, res.body.data.mediaUrl);
    });

    await step('Ask My Business is answered by the ML service using the business snapshot', async () => {
      const res = await api('POST', '/api/ai/ask', { json: { query: 'How much rice do I have left?' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.engine, 'ml');
      assert.match(res.body.data.answer, /\[mock-ml\].*Rice/);
    });

    await step('Debt repayment via AI resolves the debt and reduces the balance', async () => {
      const emeka = await Customer.findOne({ name: /emeka/i });
      const debtBefore = await Debt.findOne({ customerId: emeka._id, status: { $ne: 'paid' } }).sort({ createdDate: 1 });
      const res = await api('POST', '/api/ai/text', { json: { text: 'Brother Emeka paid me 5,000' } });
      assert.equal(res.body.data.engine, 'ml');
      assert.equal(res.body.data.intent, 'record_debt_payment');
      assert.equal(String(res.body.data.entities.debtId), String(debtBefore._id));

      const confirm = await api('POST', `/api/ai/actions/${res.body.data.id}/confirm`);
      assert.equal(confirm.status, 200);
      const debtAfter = await Debt.findById(debtBefore._id);
      assert.equal(debtAfter.amountPaid, debtBefore.amountPaid + 5000);
    });

    await step('Low-confidence ML results are flagged for the frontend', async () => {
      const res = await api('POST', '/api/ai/text', { json: { text: 'blah blah' } });
      assert.equal(res.body.data.intent, 'other');
      assert.equal(res.body.data.lowConfidence, true);
    });

    const Alert = require('../modules/alerts/alertModel');
    const { generateInsights } = require('../modules/alerts/insightService');
    const businessId = rice.businessId;

    await step('Insights come from the ML service (POST /insights) and are stored as alerts once', async () => {
      await Alert.deleteMany({ businessId, type: 'insight' });
      const created = await generateInsights(businessId);
      assert.ok(created.length >= 1, 'mock returns restock insights for fast sellers');
      assert.ok(created.every((a) => a.metadata.engine === 'ml' && a.message.startsWith('[mock-ml]')));
      assert.equal((await generateInsights(businessId)).length, 0, 'same insight keys are not repeated');
    });

    await step('Media retention deletes old files but keeps the AI action audit record', async () => {
      const { purgeExpiredMedia } = require('../modules/ai/mediaRetentionService');
      const withMedia = await AIAction.find({ businessId, 'media.provider': 'local' });
      assert.ok(withMedia.length >= 2, 'earlier steps uploaded audio and a receipt');
      const [old, fresh] = withMedia;
      // Backdate one action past the retention period (raw update: Mongoose protects createdAt)
      await AIAction.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) } });

      process.env.MEDIA_RETENTION_DAYS = '0';
      assert.equal((await purgeExpiredMedia()).enabled, false, '0 disables retention');
      process.env.MEDIA_RETENTION_DAYS = '90';
      const result = await purgeExpiredMedia();
      assert.equal(result.deleted, 1);
      delete process.env.MEDIA_RETENTION_DAYS;

      const purged = await AIAction.findById(old._id);
      assert.ok(purged, 'the audit record is kept');
      assert.ok(purged.media.deletedAt);
      assert.equal(fs.existsSync(path.join(uploadDir, purged.media.fileName)), false);
      const gone = await fetch(`${baseUrl}/api/ai/actions/${old._id}/media`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(gone.status, 410);
      assert.equal((await gone.json()).code, 'MEDIA_EXPIRED');

      assert.ok(fs.existsSync(path.join(uploadDir, (await AIAction.findById(fresh._id)).media.fileName)), 'recent media is kept');
    });

    // --- ML service goes down: everything must keep working on the local fallback ---
    await new Promise((resolve) => mlServer.close(resolve));
    mlServer = null;
    mlService.resetAvailability();

    await step('Insights fall back to local rules (weekend demand) when the ML service is down', async () => {
      await Alert.deleteMany({ businessId, type: 'insight' });
      const created = await generateInsights(businessId);
      assert.equal(created.length, 1);
      assert.equal(created[0].metadata.insightKey, 'weekend_demand');
      assert.equal(created[0].metadata.engine, 'local');
      mlService.resetAvailability();
    });

    await step('Text command falls back to the local parser when the ML service is down', async () => {
      const res = await api('POST', '/api/ai/text', { json: { text: 'I bought 5 bags of rice for 400,000 naira' } });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.engine, 'local');
      assert.equal(res.body.data.intent, 'add_inventory');
    });

    await step('Receipt and Ask My Business fall back to local', async () => {
      const receipt = await api('POST', '/api/ai/receipt', { form: fileForm('image', 'invoice.jpg', 'image/jpeg') });
      assert.equal(receipt.body.data.engine, 'local');
      const ask = await api('POST', '/api/ai/ask', { json: { query: 'What was my profit last month?' } });
      assert.equal(ask.body.data.engine, 'local');
    });

    await step('Voice note without transcript returns 422 when ML is down', async () => {
      const res = await api('POST', '/api/ai/voice', { form: fileForm('audio', 'note.m4a', 'audio/mp4') });
      assert.equal(res.status, 422);
    });

    await step('Local parser handles debt repayment too', async () => {
      const res = await api('POST', '/api/ai/text', { json: { text: 'Brother Emeka paid me 2,000' } });
      assert.equal(res.body.data.engine, 'local');
      assert.equal(res.body.data.intent, 'record_debt_payment');
      const confirm = await api('POST', `/api/ai/actions/${res.body.data.id}/confirm`);
      assert.equal(confirm.status, 200);
    });

    console.log('\nALL ML INTEGRATION TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL ML integration test failed:', err);
    process.exitCode = 1;
  } finally {
    if (apiServer) apiServer.close();
    if (mlServer) mlServer.close();
    await disconnectDB();
    // Remove the fake audio/image files this suite uploaded
    for (const name of fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []) {
      const file = path.join(uploadDir, name);
      if (fs.statSync(file).mtimeMs >= startedAt) fs.unlinkSync(file);
    }
  }
};

run();
