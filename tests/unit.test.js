const test = require('node:test');
const assert = require('node:assert/strict');
const AppError = require('../common/utils/AppError');
const errorHandler = require('../common/middleware/errorHandler');
const { calculateDaysOfStockRemaining } = require('../modules/inventory/stockService');
const { getAgeingBucket } = require('../modules/debts/debtService');
const mediaStorage = require('../modules/ai/mediaStorageService');
const { parseRange } = require('../modules/reports/reportService');

const invokeErrorHandler = (error) => {
  let response;
  const res = {
    status(statusCode) {
      response = { statusCode };
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  errorHandler(error, { method: 'GET', originalUrl: '/test' }, res, () => {});
  return response;
};

test('stock remaining days handles depleted, unsold, and selling inventory', () => {
  assert.equal(calculateDaysOfStockRemaining(0, 10), 0);
  assert.equal(calculateDaysOfStockRemaining(5, 0), 999);
  assert.equal(calculateDaysOfStockRemaining(10, 14), 10);
  assert.equal(calculateDaysOfStockRemaining(4, 28), 2);
});

test('debt ageing buckets retain their documented day boundaries', () => {
  assert.equal(getAgeingBucket(0), 'under7Days');
  assert.equal(getAgeingBucket(7), 'under7Days');
  assert.equal(getAgeingBucket(8), 'between8And14Days');
  assert.equal(getAgeingBucket(14), 'between8And14Days');
  assert.equal(getAgeingBucket(15), 'between15And30Days');
  assert.equal(getAgeingBucket(30), 'between15And30Days');
  assert.equal(getAgeingBucket(31), 'over30Days');
});

test('report date parsing rejects impossible calendar dates', () => {
  assert.throws(() => parseRange({ from: '2026-02-30', to: '2026-03-02' }), (error) =>
    error.code === 'INVALID_DATE'
  );
  assert.throws(() => parseRange({ from: '2026-13-01', to: '2026-13-02' }), (error) =>
    error.code === 'INVALID_DATE'
  );
  assert.equal(parseRange({ from: '2026-02-28', to: '2026-03-01' }).days, 2);
});

test('expected errors preserve status, code, and useful messages', () => {
  const response = invokeErrorHandler(new AppError(409, 'Not enough stock', 'INSUFFICIENT_STOCK'));
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'INSUFFICIENT_STOCK');
  assert.equal(response.body.message, 'Not enough stock');
});

test('unexpected server errors never expose internal messages', () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const response = invokeErrorHandler(new Error('database password leaked'));
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.message, 'Internal Server Error');
    assert.equal(response.body.stack, undefined);
    assert.equal(JSON.stringify(response.body).includes('database password'), false);
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  }
});

test('Cloudinary configuration accepts a full CLOUDINARY_URL or all individual credentials', () => {
  const keys = ['CLOUDINARY_URL', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(mediaStorage.isCloudinaryConfigured(), false);

    process.env.CLOUDINARY_URL = 'cloudinary://api-key:api-secret@cloud-name';
    assert.equal(mediaStorage.isCloudinaryConfigured(), true);

    process.env.CLOUDINARY_URL = 'https://invalid.example';
    assert.equal(mediaStorage.isCloudinaryConfigured(), false);

    delete process.env.CLOUDINARY_URL;
    process.env.CLOUDINARY_CLOUD_NAME = 'cloud-name';
    process.env.CLOUDINARY_API_KEY = 'api-key';
    assert.equal(mediaStorage.isCloudinaryConfigured(), false);
    process.env.CLOUDINARY_API_SECRET = 'api-secret';
    assert.equal(mediaStorage.isCloudinaryConfigured(), true);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

const { weekendDemandInsight } = require('../modules/alerts/insightService');
const { getRetentionDays } = require('../modules/ai/mediaRetentionService');

const insightContext = ({ weekend, weekday, activeDays = 20 }) => ({
  dailySales: {
    series: Array.from({ length: 28 }, (_, i) => ({ revenue: i < activeDays ? 1000 : 0 })),
    byWeekday: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((dayOfWeek) => ({
      dayOfWeek,
      days: 4,
      avgRevenue: ['Friday', 'Saturday'].includes(dayOfWeek) ? weekend : weekday,
    })),
  },
  salesRate: { products: [{ name: 'Rice', avgDailyUnits: 2 }, { name: 'Milk', avgDailyUnits: 1 }] },
});

test('weekend-demand insight needs a 1.5x weekend lift and enough history', () => {
  const insight = weekendDemandInsight(insightContext({ weekend: 30000, weekday: 10000 }));
  assert.equal(insight.key, 'weekend_demand');
  assert.equal(insight.data.ratio, 3);
  assert.equal(insight.data.product, 'Rice');
  assert.ok(insight.messageLocalized.yo && insight.messageLocalized.ha && insight.messageLocalized.ig);

  assert.equal(weekendDemandInsight(insightContext({ weekend: 14000, weekday: 10000 })), null, 'below 1.5x');
  assert.equal(weekendDemandInsight(insightContext({ weekend: 30000, weekday: 10000, activeDays: 10 })), null, 'too little data');
  assert.equal(weekendDemandInsight(insightContext({ weekend: 30000, weekday: 0 })), null, 'no weekday sales');
});

test('media retention defaults to 90 days, 0 disables, invalid values fall back', () => {
  const saved = process.env.MEDIA_RETENTION_DAYS;
  try {
    delete process.env.MEDIA_RETENTION_DAYS;
    assert.equal(getRetentionDays(), 90);
    process.env.MEDIA_RETENTION_DAYS = '0';
    assert.equal(getRetentionDays(), 0);
    process.env.MEDIA_RETENTION_DAYS = '30';
    assert.equal(getRetentionDays(), 30);
    process.env.MEDIA_RETENTION_DAYS = '-5';
    assert.equal(getRetentionDays(), 90);
    process.env.MEDIA_RETENTION_DAYS = 'soon';
    assert.equal(getRetentionDays(), 90);
  } finally {
    if (saved === undefined) delete process.env.MEDIA_RETENTION_DAYS;
    else process.env.MEDIA_RETENTION_DAYS = saved;
  }
});

test('report ranges are inclusive Lagos calendar days', () => {
  const range = parseRange({ from: '2026-10-01', to: '2026-10-07' });
  assert.equal(range.days, 7);
  assert.equal(range.start.toISOString(), '2026-09-30T23:00:00.000Z'); // midnight WAT = 23:00 UTC
  assert.equal(range.end.toISOString(), '2026-10-07T23:00:00.000Z');
});
