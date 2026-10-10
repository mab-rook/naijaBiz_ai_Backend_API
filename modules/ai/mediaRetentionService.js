const AIAction = require('./aiActionModel');
const { deleteUpload } = require('./mediaStorageService');

/**
 * Media retention: uploaded voice notes and receipt photos are deleted from storage after
 * MEDIA_RETENTION_DAYS (default 90; 0 disables). The AIAction itself is never deleted: it stays
 * in the audit trail with `media.deletedAt` set, and GET /ai/actions/:id/media returns 410.
 * Runs inside the scheduled scan (alertScheduler.js), under its lease.
 */

const BATCH_SIZE = 200;

const getRetentionDays = () => {
  const raw = process.env.MEDIA_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 90;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : 90;
};

const purgeExpiredMedia = async ({ now = new Date() } = {}) => {
  const days = getRetentionDays();
  if (days === 0) return { enabled: false, deleted: 0, failures: 0 };

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const expired = await AIAction.find({
    'media.provider': { $exists: true },
    'media.deletedAt': null,
    createdAt: { $lt: cutoff },
    status: { $ne: 'executing' }, // never touch an action that is being confirmed right now
  })
    .select('media')
    .limit(BATCH_SIZE);

  let deleted = 0;
  let failures = 0;
  for (const action of expired) {
    try {
      await deleteUpload(action.media);
      await AIAction.updateOne({ _id: action._id }, { $set: { 'media.deletedAt': now } });
      deleted += 1;
    } catch (err) {
      failures += 1;
      console.error(`[media] could not delete media for AI action ${action._id}: ${err.message}`);
    }
  }
  if (deleted || failures) {
    console.log(`[media] retention (${days} days): deleted ${deleted} file(s), ${failures} failure(s)`);
  }
  return { enabled: true, retentionDays: days, deleted, failures };
};

module.exports = { purgeExpiredMedia, getRetentionDays };
