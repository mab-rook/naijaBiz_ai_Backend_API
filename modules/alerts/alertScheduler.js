const Business = require('../auth/businessModel');
const { generateProactiveAlerts } = require('./alertService');
const { runWithLease } = require('../../common/utils/distributedLease');
const { purgeExpiredMedia } = require('../ai/mediaRetentionService');

/**
 * Scheduled proactive alerts: every ALERT_SCAN_INTERVAL_MINUTES (default 60) scan every business
 * for low stock, restock timing, overdue debts, sales drops and rising expenses.
 * alertService de-duplicates, so re-running a scan does not spam the merchant.
 *
 * Every API instance may run the timer. A MongoDB lease elects one instance to scan at a time.
 */

const LEASE_ID = 'proactive-alert-scan';
let intervalTimer = null;
let initialTimer = null;
let running = false;
let lastRun = null;

const runAlertScan = async ({ shouldContinue = () => true } = {}) => {
  if (running) {
    return { skipped: true, reason: 'previous scan still running' };
  }
  running = true;
  const startedAt = new Date();
  const summary = { startedAt, businesses: 0, alertsCreated: 0, failures: 0 };

  try {
    const businesses = await Business.find().select('_id name');
    summary.businesses = businesses.length;
    for (const business of businesses) {
      if (!shouldContinue()) {
        summary.stoppedEarly = true;
        break;
      }
      try {
        const alerts = await generateProactiveAlerts(business._id);
        summary.alertsCreated += alerts.length;
      } catch (err) {
        // One broken business must not stop the scan for the others
        summary.failures += 1;
        console.error(`[alerts] scan failed for business ${business._id}: ${err.message}`);
      }
    }
  } finally {
    running = false;
    summary.durationMs = Date.now() - startedAt.getTime();
    lastRun = summary;
  }

  console.log(
    `[alerts] scan done: ${summary.businesses} business(es), ${summary.alertsCreated} new alert(s), ` +
      `${summary.failures} failure(s), ${summary.durationMs}ms`
  );
  return summary;
};

const runLeasedAlertScan = async () => {
  if (running) {
    return { skipped: true, reason: 'previous scan still running' };
  }

  const outcome = await runWithLease(LEASE_ID, async ({ isLeaseOwned }) => {
    const summary = await runAlertScan({ shouldContinue: isLeaseOwned });
    // Housekeeping under the same lease, so only one instance deletes media
    if (isLeaseOwned()) {
      try {
        summary.media = await purgeExpiredMedia();
      } catch (err) {
        console.error('[media] retention job failed:', err.message);
      }
    }
    return summary;
  });
  if (!outcome.acquired) {
    return { skipped: true, reason: 'another API instance holds the scheduler lease' };
  }
  return outcome.leaseLost
    ? { ...outcome.value, skipped: true, reason: 'scheduler lease was lost' }
    : outcome.value;
};

const safeRun = () => runLeasedAlertScan().catch((err) => console.error('[alerts] scan crashed:', err));

const startAlertScheduler = () => {
  if (process.env.ALERT_SCHEDULER_ENABLED === 'false') {
    console.log('[alerts] scheduler disabled (ALERT_SCHEDULER_ENABLED=false)');
    return false;
  }
  if (intervalTimer) return true;

  const minutes = Number(process.env.ALERT_SCAN_INTERVAL_MINUTES) || 60;
  const initialDelayMs = Number(process.env.ALERT_SCAN_INITIAL_DELAY_MS) || 10000;

  initialTimer = setTimeout(safeRun, initialDelayMs);
  intervalTimer = setInterval(safeRun, minutes * 60 * 1000);
  // Don't keep the process alive just for the scheduler
  initialTimer.unref();
  intervalTimer.unref();

  console.log(`[alerts] scheduler started: every ${minutes} minute(s), first scan in ${Math.round(initialDelayMs / 1000)}s`);
  return true;
};

const stopAlertScheduler = () => {
  clearTimeout(initialTimer);
  clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
};

const getSchedulerStatus = () => ({
  enabled: Boolean(intervalTimer),
  intervalMinutes: Number(process.env.ALERT_SCAN_INTERVAL_MINUTES) || 60,
  running,
  lastRun,
});

module.exports = {
  runAlertScan,
  startAlertScheduler,
  stopAlertScheduler,
  getSchedulerStatus,
};
