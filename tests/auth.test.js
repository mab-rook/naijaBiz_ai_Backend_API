/**
 * JWT authentication tests: token issuing, verification hardening and the DEMO_MODE shortcut.
 */
const http = require('http');
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');
const jwt = require('jsonwebtoken');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_that_is_definitely_longer_than_32_chars';
process.env.DEMO_MODE = 'false';
process.env.ML_SERVICE_URL = '';

const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
const { assertJwtConfig } = require('../modules/auth/tokenService');
const User = require('../modules/auth/userModel');
const Business = require('../modules/auth/businessModel');
const RefreshToken = require('../modules/auth/refreshTokenModel');

let server;
let baseUrl;

const call = async (method, endpoint, { json, headers = {} } = {}) => {
  const opts = { method, headers: { ...headers } };
  if (json) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}${endpoint}`, opts);
  return { status: res.status, body: await res.json() };
};

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const signWith = (payload, secret, options) => jwt.sign(payload, secret, { algorithm: 'HS256', ...options });
const validClaims = (userId) => ({ subject: String(userId), issuer: 'naijabiz-api', audience: 'naijabiz-app' });

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('JWT auth tests\n');
  try {
    await connectDB();
    await seedDatabase();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    let token;
    let newUserId;

    await step('Registration rejects invalid schema fields and injected business ids', async () => {
      const invalidLanguage = await call('POST', '/api/auth/register', {
        json: {
          name: 'Invalid Trader',
          phone: '08099990001',
          password: 'secret123',
          preferredLanguage: 'fr',
        },
      });
      assert.equal(invalidLanguage.status, 400);
      assert.equal(invalidLanguage.body.code, 'VALIDATION_ERROR');

      const injectedBusiness = await call('POST', '/api/auth/register', {
        json: {
          name: 'Injected Trader',
          phone: '08099990002',
          password: 'secret123',
          businessId: '64b000000000000000000000',
        },
      });
      assert.equal(injectedBusiness.status, 400);
      assert.equal(injectedBusiness.body.code, 'VALIDATION_ERROR');
    });

    await step('Failed registration rolls back user, business, and refresh token together', async () => {
      const phone = '08099990003';
      const refreshTokensBefore = await RefreshToken.countDocuments();
      const originalCreate = Business.create;
      Business.create = async function () {
        throw new Error('Injected business creation failure');
      };
      let response;
      try {
        response = await call('POST', '/api/auth/register', {
          json: { name: 'Rollback Trader', phone, password: 'secret123' },
        });
      } finally {
        Business.create = originalCreate;
      }
      assert.equal(response.status, 500);
      assert.equal(await User.countDocuments({ phone }), 0);
      assert.equal(await Business.countDocuments({ name: "Rollback Trader's Store" }), 0);
      assert.equal(await RefreshToken.countDocuments(), refreshTokensBefore);
    });

    await step('Register returns a working Bearer token', async () => {
      const res = await call('POST', '/api/auth/register', {
        json: { name: 'Test Trader', phone: '08099990000', password: 'secret123', businessName: 'Test Shop' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.tokenType, 'Bearer');
      assert.ok(res.body.expiresIn);
      const decoded = jwt.decode(res.body.token);
      assert.equal(decoded.iss, 'naijabiz-api');
      assert.equal(decoded.aud, 'naijabiz-app');
      assert.equal(decoded.sub, String(res.body.user.id));
      assert.equal(decoded.businessId, String(res.body.user.business.id));
      newUserId = res.body.user.id;

      const me = await call('GET', '/api/auth/me', { headers: bearer(res.body.token) });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.phone, '08099990000');
    });

    await step('Login works and only sees the merchant\'s own business data', async () => {
      const res = await call('POST', '/api/auth/login', { json: { phone: '08023456789', password: 'password123' } });
      assert.equal(res.status, 200);
      token = res.body.token;
      const products = await call('GET', '/api/products', { headers: bearer(token) });
      assert.equal(products.status, 200);
      assert.ok(products.body.count > 0);

      const newUserLogin = await call('POST', '/api/auth/login', { json: { phone: '08099990000', password: 'secret123' } });
      const otherProducts = await call('GET', '/api/products', { headers: bearer(newUserLogin.body.token) });
      assert.equal(otherProducts.body.count, 0, 'a new business must not see the seeded shop\'s products');
    });

    await step('Wrong password is rejected with a generic message', async () => {
      const res = await call('POST', '/api/auth/login', { json: { phone: '08023456789', password: 'wrong' } });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'Invalid phone number or password');
    });

    await step('Missing or malformed Authorization header -> TOKEN_MISSING', async () => {
      for (const headers of [{}, { Authorization: token }, { Authorization: `Token ${token}` }, { Authorization: 'Bearer' }]) {
        const res = await call('GET', '/api/products', { headers });
        assert.equal(res.status, 401);
        assert.equal(res.body.code, 'TOKEN_MISSING');
      }
    });

    const user = await User.findOne({ phone: '08023456789' });
    const invalidTokens = {
      garbage: 'not.a.jwt',
      'wrong secret': signWith({}, 'some_other_secret_some_other_secret!!', validClaims(user._id)),
      'alg none': `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub: String(user._id), iss: 'naijabiz-api', aud: 'naijabiz-app' })
      ).toString('base64url')}.`,
      'old format {id} without issuer/audience': signWith({ id: String(user._id) }, process.env.JWT_SECRET),
      'wrong audience': signWith({}, process.env.JWT_SECRET, { ...validClaims(user._id), audience: 'someone-else' }),
    };

    await step('Forged / tampered / old-format tokens -> TOKEN_INVALID', async () => {
      for (const [label, badToken] of Object.entries(invalidTokens)) {
        const res = await call('GET', '/api/products', { headers: bearer(badToken) });
        assert.equal(res.status, 401, label);
        assert.equal(res.body.code, 'TOKEN_INVALID', label);
        assert.equal(res.body.error, undefined, 'must not leak jwt library errors');
      }
    });

    await step('Expired token -> TOKEN_EXPIRED', async () => {
      const expired = signWith({}, process.env.JWT_SECRET, { ...validClaims(user._id), expiresIn: -10 });
      const res = await call('GET', '/api/products', { headers: bearer(expired) });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'TOKEN_EXPIRED');
    });

    await step('Token for a deleted user -> USER_NOT_FOUND', async () => {
      const ghost = await call('POST', '/api/auth/login', { json: { phone: '08099990000', password: 'secret123' } });
      await User.deleteOne({ _id: newUserId });
      const res = await call('GET', '/api/products', { headers: bearer(ghost.body.token) });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'USER_NOT_FOUND');
    });

    await step('DEMO_MODE=true lets token-less requests through, but never in production', async () => {
      process.env.DEMO_MODE = 'true';
      const demo = await call('GET', '/api/products');
      assert.equal(demo.status, 200);

      process.env.NODE_ENV = 'production';
      const prod = await call('GET', '/api/products');
      assert.equal(prod.status, 401);

      process.env.NODE_ENV = 'test';
      process.env.DEMO_MODE = 'false';
      const off = await call('GET', '/api/products');
      assert.equal(off.status, 401);
    });

    await step('Startup check rejects missing or short JWT_SECRET in production', async () => {
      const saved = { secret: process.env.JWT_SECRET, env: process.env.NODE_ENV };
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'short';
      assert.throws(assertJwtConfig, /at least 32 characters/);
      delete process.env.JWT_SECRET;
      assert.throws(assertJwtConfig, /must be set/);
      process.env.JWT_SECRET = saved.secret;
      process.env.NODE_ENV = saved.env;
      assert.doesNotThrow(assertJwtConfig);
    });

    await step('CORS only allows origins listed in CORS_ORIGINS', async () => {
      process.env.CORS_ORIGINS = 'http://allowed.example, http://localhost:3000/';
      const allowed = await fetch(`${baseUrl}/`, { headers: { Origin: 'http://localhost:3000' } });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
      const blocked = await fetch(`${baseUrl}/`, { headers: { Origin: 'http://evil.example' } });
      assert.equal(blocked.headers.get('access-control-allow-origin'), null);
      const noOrigin = await fetch(`${baseUrl}/`);
      assert.equal(noOrigin.status, 200, 'mobile apps / curl send no Origin and must still work');
      delete process.env.CORS_ORIGINS;
    });

    await step('Login is rate limited per phone number (429 + Retry-After)', async () => {
      const limit = 10;
      let lastStatus;
      let lastRes;
      for (let i = 1; i <= limit + 1; i++) {
        lastRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: '08011112222', password: 'guess' + i }),
        });
        lastStatus = lastRes.status;
        if (i <= limit) assert.equal(lastStatus, 401, `attempt ${i} should reach the password check`);
      }
      assert.equal(lastStatus, 429);
      assert.ok(Number(lastRes.headers.get('retry-after')) > 0);
      assert.equal((await lastRes.json()).code, 'RATE_LIMITED');

      // A different phone number is not affected by that block
      const other = await call('POST', '/api/auth/login', { json: { phone: '08023456789', password: 'password123' } });
      assert.equal(other.status, 200);
    });

    console.log('\nALL AUTH TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Auth test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await disconnectDB();
  }
};

run();
