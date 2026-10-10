const mongoose = require('mongoose');

const distributedLeaseSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, default: null },
    leaseUntil: { type: Date, required: true },
  },
  {
    versionKey: false,
    collection: 'distributed_leases',
  }
);

module.exports = mongoose.models.DistributedLease
  || mongoose.model('DistributedLease', distributedLeaseSchema);
