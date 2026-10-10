const mongoose = require('mongoose');

const debtPaymentSchema = new mongoose.Schema({
  date: {
    type: Date,
    default: Date.now,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  note: {
    type: String,
    default: '',
  },
});

const debtSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sale',
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    amountPaid: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['unpaid', 'partial', 'paid'],
      default: 'unpaid',
    },
    createdDate: {
      type: Date,
      default: Date.now,
    },
    dueDate: {
      type: Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // Default 14 days credit
    },
    payments: [debtPaymentSchema],
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for calculating debt age in days
debtSchema.virtual('daysOutstanding').get(function () {
  const start = this.createdDate ? new Date(this.createdDate).getTime() : this.createdAt.getTime();
  const diffTime = Math.abs(Date.now() - start);
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
});

// Virtual for remaining balance
debtSchema.virtual('balanceRemaining').get(function () {
  return Math.max(0, this.amount - this.amountPaid);
});

debtSchema.index({ businessId: 1, status: 1 });

module.exports = mongoose.model('Debt', debtSchema);

