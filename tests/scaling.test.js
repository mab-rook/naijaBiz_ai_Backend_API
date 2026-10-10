const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';

const { connectDB, disconnectDB } = require('../config/db');
const RateLimitCounter = require('../common/models/rateLimitCounterModel');
const {
  createRateLimiter,
  initializeRateLimiterStore,
} = require('../common/middleware/rateLimiter');
const { acquireLease, renewLease, releaseLease } = require('../common/utils/distributedLease');

const invokeLimiter = async (limiter, req) => {
  const response = { headers: {}, statusCode: 200, body: null };
  const res = {
    set(name, value) {
      response.headers[name] = value;
      return this;
    },
    status(statusCode) {
      response.statusCode = statusCode;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  let passed = false;
  await limiter(req, res, (err) => {
    if (err) throw err;
    passed = true;
  });
  return { ...response, passed };
};

const run = async () => {
  try {
    await connectDB();
    await initializeRateLimiterStore();

    const request = { ip: '203.0.113.42', body: { phone: '08012345678' } };
    const firstInstance = createRateLimiter({
      name: 'scaling-test',
      windowMs: 60000,
      max: 2,
      keyFn: (req) => `phone:${req.body.phone}`,
    });
    const secondInstance = createRateLimiter({
      name: 'scaling-test',
      windowMs: 60000,
      max: 2,
      keyFn: (req) => `phone:${req.body.phone}`,
    });

    const allowed1 = await invokeLimiter(firstInstance, request);
    const allowed2 = await invokeLimiter(secondInstance, request);
    const blocked = await invokeLimiter(firstInstance, request);
    assert.equal(allowed1.passed, true);
    assert.equal(allowed2.passed, true);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.code, 'RATE_LIMITED');
    assert.equal(blocked.headers['RateLimit-Remaining'], '0');
    const storedCounter = await RateLimitCounter.findOne({ limiterName: 'scaling-test' }).lean();
    assert.ok(storedCounter);
    assert.equal(storedCounter.count, 3);
    assert.equal(JSON.stringify(storedCounter).includes(request.body.phone), false);
    await firstInstance.reset();
    console.log('PASS Rate limit counters are shared across independent middleware instances and hash identifiers');

    const concurrentLimiters = [
      createRateLimiter({ name: 'scaling-concurrency-test', windowMs: 60000, max: 3 }),
      createRateLimiter({ name: 'scaling-concurrency-test', windowMs: 60000, max: 3 }),
    ];
    const concurrentResults = await Promise.all(
      Array.from({ length: 12 }, (_, i) => invokeLimiter(concurrentLimiters[i % 2], {
        ip: '203.0.113.99',
        body: {},
      }))
    );
    assert.equal(concurrentResults.filter((result) => result.passed).length, 3);
    assert.equal(concurrentResults.filter((result) => result.statusCode === 429).length, 9);
    await RateLimitCounter.deleteMany({ limiterName: 'scaling-concurrency-test' });
    console.log('PASS Concurrent requests across instances cannot exceed the shared rate limit');

    const leaseName = 'scaling-test-lease';
    const leases = await Promise.all([
      acquireLease(leaseName, 60000),
      acquireLease(leaseName, 60000),
    ]);
    const owners = leases.filter(Boolean);
    assert.equal(owners.length, 1, 'exactly one instance should acquire the scheduler lease');
    assert.equal(await renewLease(leaseName, owners[0], 60000), true);
    const nonOwner = `not-${owners[0]}`;
    await releaseLease(leaseName, nonOwner);
    assert.equal(await acquireLease(leaseName, 60000), null, 'a non-owner cannot release the lease');
    await releaseLease(leaseName, owners[0]);
    const reacquired = await acquireLease(leaseName, 60000);
    assert.ok(reacquired, 'lease is available after its owner releases it');
    await releaseLease(leaseName, reacquired);
    console.log('PASS Alert scheduler lease is exclusive, renewable, and owner-released');
  } catch (err) {
    console.error('FAIL Scaling tests failed:', err);
    process.exitCode = 1;
  } finally {
    await disconnectDB();
  }
};

run();
