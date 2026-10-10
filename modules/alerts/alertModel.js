const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    type: {
      type: String,
      // 'insight' = recommendation from the ML service or the backend's own rules (e.g. weekend demand)
      enum: ['low_stock', 'sales_drop', 'rising_expenses', 'overdue_debt', 'restock_suggestion', 'insight'],
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    message: {
      type: String,
      required: true,
    },
    messageLocalized: {
      yo: { type: String, default: '' },
      ha: { type: String, default: '' },
      ig: { type: String, default: '' },
    },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      default: 'warning',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

alertSchema.index({ businessId: 1, createdAt: -1 });

module.exports = mongoose.model('Alert', alertSchema);

