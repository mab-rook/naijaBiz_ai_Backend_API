/**
 * Proactive alerts: rising-expenses alert, low-stock de-duplication and the scheduled scan.
 */
const assert = require('assert/strict');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });
process.env.NODE_ENV = 'test';

const { connectDB, disconnectDB } = require('../config/db');
const seedDatabase = require('../seed/seedData');
const Business = require('../modules/auth/businessModel');
const Product = require('../modules/products/productModel');
const Expense = require('../modules/expenses/expenseModel');
const Alert = require('../modules/alerts/alertModel');
const { generateProactiveAlerts } = require('../modules/alerts/alertService');
const { recordStockMovement } = require('../modules/inventory/stockService');
const { runAlertScan, startAlertScheduler, stopAlertScheduler, getSchedulerStatus } = require('../modules/alerts/alertScheduler');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const step = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
};

const run = async () => {
  console.log('Alerts tests\n');
  try {
    await connectDB();
    await seedDatabase();
    const business = await Business.findOne();
    const businessId = business._id;

    await step('Rising expenses alert names the category that grew most, and is not repeated', async () => {
      await Expense.deleteMany({ businessId });
      await Alert.deleteMany({ businessId, type: 'rising_expenses' });
      await Expense.create([
        { businessId, category: 'transport', amount: 10000, date: daysAgo(10) },
        { businessId, category: 'power', amount: 10000, date: daysAgo(9) },
        { businessId, category: 'transport', amount: 12000, date: daysAgo(2) },
        { businessId, category: 'power', amount: 38000, date: daysAgo(1) },
      ]);

      await generateProactiveAlerts(businessId);
      const alerts = await Alert.find({ businessId, type: 'rising_expenses' });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].metadata.risePercent, 150);
      assert.equal(alerts[0].metadata.topCategory, 'power');
      assert.equal(alerts[0].severity, 'critical');
      assert.ok(alerts[0].messageLocalized.yo.length > 0);

      await generateProactiveAlerts(businessId);
      assert.equal(await Alert.countDocuments({ businessId, type: 'rising_expenses' }), 1, 'no duplicate within 7 days');
    });

    await step('No rising expenses alert when the increase is below the threshold', async () => {
      await Expense.deleteMany({ businessId });
      await Alert.deleteMany({ businessId, type: 'rising_expenses' });
      await Expense.create([
        { businessId, category: 'rent', amount: 20000, date: daysAgo(10) },
        { businessId, category: 'rent', amount: 22000, date: daysAgo(2) },
      ]);
      await generateProactiveAlerts(businessId);
      assert.equal(await Alert.countDocuments({ businessId, type: 'rising_expenses' }), 0);
    });

    await step('Repeated sales below minimum stock create one low-stock alert, then one critical at zero', async () => {
      const product = await Product.create({
        businessId,
        name: 'Test Peak Milk',
        unit: 'tin',
        sellingPrice: 3000,
        costPrice: 2500,
        currentStock: 6,
        minimumStock: 5,
      });
      for (let i = 0; i < 3; i++) {
        await recordStockMovement({ businessId, productId: product._id, type: 'sale', quantity: 1, unitCost: 2500 });
      }
      const warnings = await Alert.find({ businessId, type: 'low_stock', 'metadata.productId': product._id });
      assert.equal(warnings.length, 1, `expected 1 low-stock alert, got ${warnings.length}`);
      assert.equal(warnings[0].severity, 'warning');

      await recordStockMovement({ businessId, productId: product._id, type: 'sale', quantity: 2, unitCost: 2500 });
      await recordStockMovement({ businessId, productId: product._id, type: 'damaged', quantity: 1, unitCost: 2500 });
      await assert.rejects(
        recordStockMovement({ businessId, productId: product._id, type: 'sale', quantity: 1, unitCost: 2500 }),
        (err) => err.code === 'INSUFFICIENT_STOCK' && err.statusCode === 409
      );
      const all = await Alert.find({ businessId, type: 'low_stock', 'metadata.productId': product._id });
      assert.equal(all.length, 2);
      assert.equal(all.filter((a) => a.severity === 'critical').length, 1);
    });

    await step('Scheduled scan covers every business and skips overlapping runs', async () => {
      const second = await Business.create({ name: 'Second Shop', owner: business.owner });
      await Product.create({
        businessId: second._id,
        name: 'Second Shop Sugar',
        unit: 'bag',
        sellingPrice: 70000,
        costPrice: 65000,
        currentStock: 1,
        minimumStock: 4,
      });

      const [first, overlapping] = await Promise.all([runAlertScan(), runAlertScan()]);
      assert.ok(first.businesses >= 2);
      assert.equal(first.failures, 0);
      assert.equal(overlapping.skipped, true);
      assert.ok(await Alert.findOne({ businessId: second._id, type: 'low_stock' }), 'second business got its alert');
    });

    await step('Scheduler starts, runs its first scan, and stops cleanly', async () => {
      process.env.ALERT_SCAN_INITIAL_DELAY_MS = '50';
      process.env.ALERT_SCAN_INTERVAL_MINUTES = '60';
      const before = getSchedulerStatus().lastRun;
      assert.equal(startAlertScheduler(), true);
      assert.equal(getSchedulerStatus().enabled, true);
      for (let i = 0; i < 50 && getSchedulerStatus().lastRun === before; i++) await wait(100);
      assert.notEqual(getSchedulerStatus().lastRun, before, 'first scan should have run');
      stopAlertScheduler();
      assert.equal(getSchedulerStatus().enabled, false);

      process.env.ALERT_SCHEDULER_ENABLED = 'false';
      assert.equal(startAlertScheduler(), false);
      delete process.env.ALERT_SCHEDULER_ENABLED;
    });

    await step('Weekend-demand insight (local rules) is stored once and not repeated on the next scan', async () => {
      process.env.ML_SERVICE_URL = '';
      await seedDatabase();
      const seeded = await Business.findOne({ name: { $ne: 'Second Shop' } });
      const insights = await Alert.find({ businessId: seeded._id, type: 'insight' });
      assert.equal(insights.length, 1, 'seed scan should create the weekend insight');
      assert.equal(insights[0].metadata.insightKey, 'weekend_demand');
      assert.equal(insights[0].metadata.engine, 'local');
      assert.ok(insights[0].metadata.ratio >= 1.5);
      assert.ok(insights[0].messageLocalized.ha.length > 0);
      await generateProactiveAlerts(seeded._id);
      assert.equal(await Alert.countDocuments({ businessId: seeded._id, type: 'insight' }), 1);
    });

    await step('Malformed insights from the ML service are dropped', async () => {
      const { sanitizeInsight } = require('../modules/alerts/insightService');
      assert.equal(sanitizeInsight({ title: 'no key', message: 'x' }), null);
      assert.equal(sanitizeInsight('nope'), null);
      const clean = sanitizeInsight({ key: 'k', title: 'T', message: 'M', severity: 'panic', data: [1], messageLocalized: { yo: 'Y', fr: 'F' } });
      assert.equal(clean.severity, 'info');
      assert.deepEqual(clean.data, {});
      assert.deepEqual(clean.messageLocalized, { yo: 'Y' });
    });

    console.log('\nALL ALERTS TESTS PASSED\n');
  } catch (err) {
    console.error('FAIL Alerts test failed:', err);
    process.exitCode = 1;
  } finally {
    stopAlertScheduler();
    await disconnectDB();
  }
};

run();
