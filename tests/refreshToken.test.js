/**
 * Refresh token tests: token rotation, logout, logout-all, and reuse detection.
 */
const http = require('http');
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_secret_that_is_definitely_longer_than_32_chars';
process.env.DEMO_MODE = 'false';
process.env.ML_SERVICE_URL = '';

const app = require('../app');
const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
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

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('Refresh token tests\n');
  try {
    await connectDB();
    await seedDatabase();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    let accessToken;
    let refreshToken;

    // ── Register returns a refresh token ──────────────────────────────

    await step('Register returns both access and refresh tokens', async () => {
      const res = await call('POST', '/api/auth/register', {
        json: { name: 'Refresh Tester', phone: '08077770000', password: 'secret123', businessName: 'Refresh Shop' },
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.token, 'access token present');
      assert.ok(res.body.refreshToken, 'refresh token present');
      assert.equal(res.body.tokenType, 'Bearer');
      assert.ok(res.body.expiresIn, 'expiresIn present');
      assert.ok(res.body.refreshExpiresIn, 'refreshExpiresIn present');
      accessToken = res.body.token;
      refreshToken = res.body.refreshToken;
    });

    // ── Login returns a refresh token ─────────────────────────────────

    await step('Login returns both access and refresh tokens', async () => {
      const res = await call('POST', '/api/auth/login', {
        json: { phone: '08077770000', password: 'secret123' },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.ok(res.body.refreshToken);
      assert.ok(res.body.refreshExpiresIn);
      accessToken = res.body.token;
      refreshToken = res.body.refreshToken;
    });

    // ── Refresh endpoint issues new tokens (rotation) ─────────────────

    let newRefreshToken;

    await step('POST /auth/refresh rotates tokens: new access + new refresh', async () => {
      const res = await call('POST', '/api/auth/refresh', {
        json: { refreshToken },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token, 'new access token');
      assert.ok(res.body.refreshToken, 'new refresh token');
      assert.notEqual(res.body.refreshToken, refreshToken, 'refresh token must change (rotation)');
      assert.equal(res.body.tokenType, 'Bearer');
      assert.ok(res.body.expiresIn);
      assert.ok(res.body.refreshExpiresIn);

      // The new access token must work
      const me = await call('GET', '/api/auth/me', { headers: bearer(res.body.token) });
      assert.equal(me.status, 200);

      newRefreshToken = res.body.refreshToken;
    });

    // ── Reuse of the old (rotated) refresh token is detected ──────────

    await step('Reusing an already-rotated refresh token → 401 and revokes the family', async () => {
      const res = await call('POST', '/api/auth/refresh', {
        json: { refreshToken }, // the OLD one, already rotated
      });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'REFRESH_TOKEN_INVALID');

      // The family should be revoked: even the new token should now fail
      const res2 = await call('POST', '/api/auth/refresh', {
        json: { refreshToken: newRefreshToken },
      });
      assert.equal(res2.status, 401, 'family revocation: new token also rejected');
    });

    // ── Login again to get a fresh session ─────────────────────────────

    await step('Login again to get fresh tokens after family revocation', async () => {
      const res = await call('POST', '/api/auth/login', {
        json: { phone: '08077770000', password: 'secret123' },
      });
      assert.equal(res.status, 200);
      accessToken = res.body.token;
      refreshToken = res.body.refreshToken;
    });

    // ── Missing refresh token → 400 ──────────────────────────────────

    await step('Refresh without body → 400 REFRESH_TOKEN_REQUIRED', async () => {
      const res = await call('POST', '/api/auth/refresh', { json: {} });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'REFRESH_TOKEN_REQUIRED');
    });

    await step('Refresh with garbage token → 401 REFRESH_TOKEN_INVALID', async () => {
      const res = await call('POST', '/api/auth/refresh', { json: { refreshToken: 'not_a_real_token' } });
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'REFRESH_TOKEN_INVALID');
    });

    // ── Logout revokes the access and refresh tokens ───────────────────

    await step('POST /auth/logout immediately revokes its access and refresh tokens', async () => {
      const res = await call('POST', '/api/auth/logout', {
        headers: bearer(accessToken),
        json: { refreshToken },
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('Logged out'));

      const me = await call('GET', '/api/auth/me', { headers: bearer(accessToken) });
      assert.equal(me.status, 401);
      assert.equal(me.body.code, 'TOKEN_REVOKED');

      const res2 = await call('POST', '/api/auth/refresh', {
        json: { refreshToken },
      });
      assert.equal(res2.status, 401);
    });

    await step('Logout requires access authentication and can revoke only the access token', async () => {
      const login = await call('POST', '/api/auth/login', {
        json: { phone: '08077770000', password: 'secret123' },
      });
      const res = await call('POST', '/api/auth/logout', {
        headers: bearer(login.body.token),
        json: {},
      });
      assert.equal(res.status, 200);
      const access = await call('GET', '/api/auth/me', { headers: bearer(login.body.token) });
      assert.equal(access.status, 401);
      const refresh = await call('POST', '/api/auth/refresh', {
        json: { refreshToken: login.body.refreshToken },
      });
      assert.equal(refresh.status, 200, 'omitting refreshToken leaves the refresh session active');
    });

    // ── Logout All revokes every session ──────────────────────────────

    await step('POST /auth/logout-all (requires access token) revokes all sessions', async () => {
      // Login from two "devices"
      const login1 = await call('POST', '/api/auth/login', { json: { phone: '08077770000', password: 'secret123' } });
      const login2 = await call('POST', '/api/auth/login', { json: { phone: '08077770000', password: 'secret123' } });
      assert.equal(login1.status, 200);
      assert.equal(login2.status, 200);

      // Logout all using the access token from login1
      const res = await call('POST', '/api/auth/logout-all', {
        headers: bearer(login1.body.token),
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('session(s) revoked'));

      const oldAccess = await call('GET', '/api/auth/me', { headers: bearer(login2.body.token) });
      assert.equal(oldAccess.status, 401, 'logout-all invalidates access tokens across sessions');
      assert.equal(oldAccess.body.code, 'TOKEN_REVOKED');

      // Both refresh tokens should now fail
      const r1 = await call('POST', '/api/auth/refresh', { json: { refreshToken: login1.body.refreshToken } });
      assert.equal(r1.status, 401);
      const r2 = await call('POST', '/api/auth/refresh', { json: { refreshToken: login2.body.refreshToken } });
      assert.equal(r2.status, 401);
    });

    await step('POST /auth/logout-all without access token → 401', async () => {
      const res = await call('POST', '/api/auth/logout-all');
      assert.equal(res.status, 401);
    });

    // ── Refresh token is stored hashed (not plain text) ──────────────

    await step('Refresh tokens are stored as SHA-256 hashes, not plain text', async () => {
      const login = await call('POST', '/api/auth/login', { json: { phone: '08077770000', password: 'secret123' } });
      const raw = login.body.refreshToken;
      const expectedHash = RefreshToken.hashToken(raw);

      const doc = await RefreshToken.findOne({ tokenHash: expectedHash });
      assert.ok(doc, 'found by hash');
      assert.notEqual(doc.tokenHash, raw, 'stored value is a hash, not the raw token');
    });

    await step('Concurrent refresh requests consume a token only once and revoke the replayed family', async () => {
      const login = await call('POST', '/api/auth/login', {
        json: { phone: '08077770000', password: 'secret123' },
      });
      const results = await Promise.all([
        call('POST', '/api/auth/refresh', { json: { refreshToken: login.body.refreshToken } }),
        call('POST', '/api/auth/refresh', { json: { refreshToken: login.body.refreshToken } }),
      ]);

      assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
      const winner = results.find((result) => result.status === 200);
      assert.ok(winner.body.refreshToken);
      const rotated = await call('POST', '/api/auth/refresh', { json: { refreshToken: winner.body.refreshToken } });
      assert.equal(rotated.status, 401, 'replay detection revokes the token family');
    });

    console.log('\nALL REFRESH TOKEN TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Refresh token test failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await disconnectDB();
  }
};

run();
