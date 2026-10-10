const crypto = require('crypto');
const DistributedLease = require('../models/distributedLeaseModel');

const ensureLeaseRecord = async (leaseName) => {
  try {
    await DistributedLease.updateOne(
      { _id: leaseName },
      { $setOnInsert: { ownerId: null, leaseUntil: new Date(0) } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
};

const acquireLease = async (leaseName, durationMs) => {
  await ensureLeaseRecord(leaseName);
  const ownerId = crypto.randomUUID();
  const now = new Date();
  const lease = await DistributedLease.findOneAndUpdate(
    { _id: leaseName, leaseUntil: { $lte: now } },
    { $set: { ownerId, leaseUntil: new Date(now.getTime() + durationMs) } },
    { new: true }
  );
  return lease ? ownerId : null;
};

const renewLease = async (leaseName, ownerId, durationMs) => {
  const now = new Date();
  const lease = await DistributedLease.findOneAndUpdate(
    { _id: leaseName, ownerId, leaseUntil: { $gt: now } },
    { $set: { leaseUntil: new Date(now.getTime() + durationMs) } },
    { new: true }
  );
  return Boolean(lease);
};

const releaseLease = async (leaseName, ownerId) => {
  await DistributedLease.updateOne(
    { _id: leaseName, ownerId },
    { $set: { ownerId: null, leaseUntil: new Date(0) } }
  );
};

const runWithLease = async (leaseName, callback, {
  durationMs = 2 * 60 * 1000,
  renewIntervalMs = Math.max(1000, Math.floor(durationMs / 3)),
} = {}) => {
  const ownerId = await acquireLease(leaseName, durationMs);
  if (!ownerId) return { acquired: false, value: undefined };

  let leaseLost = false;
  let renewalInProgress = false;
  const timer = setInterval(async () => {
    if (renewalInProgress || leaseLost) return;
    renewalInProgress = true;
    try {
      leaseLost = !await renewLease(leaseName, ownerId, durationMs);
    } catch (err) {
      leaseLost = true;
      console.error(`[lease] renewal failed for ${leaseName}: ${err.message}`);
    } finally {
      renewalInProgress = false;
    }
  }, renewIntervalMs);
  timer.unref();

  try {
    const value = await callback({ isLeaseOwned: () => !leaseLost });
    return { acquired: true, leaseLost, value };
  } finally {
    clearInterval(timer);
    try {
      await releaseLease(leaseName, ownerId);
    } catch (err) {
      console.error(`[lease] release failed for ${leaseName}: ${err.message}`);
    }
  }
};

module.exports = {
  acquireLease,
  renewLease,
  releaseLease,
  runWithLease,
};
