const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
    category: {
      type: String,
      required: [true, 'Please provide expense category'],
      enum: ['rent', 'transport', 'power', 'wages', 'repairs', 'security', 'food', 'other'],
      default: 'other',
    },
    amount: {
      type: Number,
      required: [true, 'Please provide expense amount in Naira'],
      min: 0,
    },
    note: {
      type: String,
      default: '',
      trim: true,
    },
    source: {
      type: String,
      enum: ['manual', 'voice', 'text', 'receipt'],
      default: 'manual',
    },
  },
  {
    timestamps: true,
  }
);

expenseSchema.index({ businessId: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);

